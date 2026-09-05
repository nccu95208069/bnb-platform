"""Split our migration SQL, preserving quoted strings and dollar-quoted bodies."""

import re


def split_sql(sql: str) -> list[str]:
    token = re.compile(r"(\$[A-Za-z_]*\$|'(?:''|[^'])*'|--[^\n]*|;)")
    statements, start, dollar = [], 0, None
    for match in token.finditer(sql):
        value = match.group()
        if value.startswith("$"):
            if dollar is None:
                dollar = value
            elif dollar == value:
                dollar = None
        elif value == ";" and dollar is None:
            if sql[start : match.start()].strip():
                statements.append(sql[start : match.start()].strip())
            start = match.end()
    if sql[start:].strip():
        statements.append(sql[start:].strip())
    return statements
