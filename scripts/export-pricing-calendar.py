"""Read-only bridge: use the pricing project's canonical rules and OwlNest reader.

Run with --pricing-repo /path/to/bnb-pricing --output /private/path/prices.json.
No engine execution, writes to OwlNest, credential copies, or guest records.
The pricing operator should run this after each verified pricing round, then publish.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import math
import re
import pathlib
import subprocess
import sys
from zoneinfo import ZoneInfo


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pricing-repo', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--end', default='2027-06-30')
    parser.add_argument('--probability-plan', type=pathlib.Path, help='Explicit T39 plan containing p_sell; no plan is executed')
    args = parser.parse_args()
    probabilities = {}
    if args.probability_plan:
        match = re.fullmatch(r't39_plan_(\d{8})\.csv', args.probability_plan.name)
        if not match:
            raise RuntimeError('Probability plan filename must identify its as-of date')
        asof = dt.datetime.strptime(match[1], '%Y%m%d').date().isoformat()
        plan_bytes = args.probability_plan.read_bytes()
        plan_version = hashlib.sha256(plan_bytes).hexdigest()[:20]
        for row in csv.DictReader(plan_bytes.decode('utf-8-sig').splitlines()):
            key = (row['date'], row['room'])
            value = float(row['p_sell'])
            if key in probabilities or not math.isfinite(value) or not 0 <= value <= 1:
                raise RuntimeError('Invalid or duplicate sale probability')
            probabilities[key] = {'value':value,'asof':asof,'source_version':plan_version}
    repo = args.pricing_repo.resolve()
    sys.path.insert(0, str(repo / 'scripts'))
    import owlnest_prices as owl
    import t39_baseline as baseline
    import build_panel

    tracked = ['scripts/owlnest_prices.py', 'scripts/t39_baseline.py', 'scripts/build_panel.py',
               'data/experiment/rack_rates.csv', 'data/experiment/rack_rates_overrides.csv']
    before = {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in tracked}
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--', *tracked]).strip():
        raise RuntimeError('Pricing inputs have uncommitted changes; use a reviewed checkout')
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    today = dt.datetime.now(ZoneInfo('Asia/Taipei')).date()
    end = dt.date.fromisoformat(args.end)
    if not 0 <= (end - today).days <= 365:
        raise RuntimeError('Invalid supported export window')
    raw = owl.http_get(str(today), str(end), owl.load_token())
    if raw.get('status') != 0:
        raise RuntimeError('OwlNest read failed')
    observed = dt.datetime.now(dt.timezone.utc).isoformat()
    channels, stocks = owl.parse_calendar_channels(raw), owl.parse_stocks(raw)
    if len(channels) != ((end - today).days + 1) * 6:
        raise RuntimeError('Incomplete room/date price coverage')
    rack = baseline.load_rack_rates(repo / 'data/experiment/rack_rates.csv')
    overrides = baseline.load_overrides(repo / 'data/experiment/rack_rates_overrides.csv')
    with (repo / 'data/experiment/t39_baseline_prices.csv').open() as stream:
        versions = {(r['date'], r['room']): r['version'] for r in csv.DictReader(stream)}
    mapping = {35000:'direct',35007:'airbnb',35005:'booking',35006:'agoda',32116:'owljourney'}
    cells = []
    for (date, room), prices in sorted(channels.items()):
        if set(prices) != set(mapping):
            raise RuntimeError('Incomplete channel coverage')
        try:
            rack_price = baseline.expected_base_price(date, room, rack, overrides)
        except KeyError:
            rack_price = None
        cells.append({'date':date,'room':room,'channels':{mapping[k]:v for k,v in prices.items()},
                      'stock':stocks.get((owl.ROOM_IDS[room],date)), 'rack_price':rack_price,
                      'sales_probability':probabilities.get((date,room)),
                      'daytype':build_panel.daytype_for_date(date), 'baseline_version':versions.get((date,room),'')})
    if before != {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in tracked}:
        raise RuntimeError('Pricing inputs changed during read; retry')
    result = {'schema':1,'property_id':'sweetfun','observed_at':observed,'source_commit':commit,'cells':cells}
    result['version'] = hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()[:20]
    # Private output only. No raw responses, names or credentials are retained.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(result,stream,ensure_ascii=False)
    print(json.dumps({'cells':len(cells),'observed_at':observed,'version':result['version']}))


if __name__ == '__main__':
    main()
