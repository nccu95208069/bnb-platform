# Evaluation / Stage 3B

## Goal

Measure Router quality objectively without requiring every future property to label hundreds or thousands of examples.

## Evaluation strategy

1. Build a small high-quality contextual Gold Set using Sweetfun.
2. Use multiple strong models to produce broader Silver labels.
3. Human-review model disagreements and high-value ambiguous cases.
4. Benchmark Router/provider/prompt versions against the same cases.
5. After launch, collect implicit owner feedback from suggestion-selection/edit behavior.

## Why contextual cases

A benchmark case should not be only one guest sentence.

Include:

- recent conversation
- known structured state
- latest guest message
- expected intent(s)
- conversation act
- required/missing fields
- identity/room resolution need
- next action
- expected reply mode

This is necessary because many real hospitality messages depend on previous owner replies or reservation context.

## Initial human-label workload

Do not start with 1,000 manually labeled cases.

A practical MVP approach:

- first human-verified set: roughly 100–200 high-value contextual cases
- prioritize top topics, multi-intent, context-dependent, identity, risky and model-disagreement cases
- start even smaller (e.g. 30–50) when testing the process

## Silver labeling

For a larger historical set:

- strong model A labels independently
- strong model B labels independently
- deterministic rules / reservation evidence validate what they can
- cases with strong agreement become Silver candidates
- disagreements are prioritized for review

Agreement is not the same as ground truth, so a smaller human-verified Gold Set remains necessary for real accuracy measurement.

## Future tenant onboarding

New properties should not need to train the global Router.

They mainly confirm their own business truth:

- check-in/out
- parking
- policies
- room facts
- current prices when applicable
- secrets/variables

The system can infer candidate Reply Topics from imported history and ask the owner to confirm only important conflicts.

## Product feedback flywheel

Normal owner behavior creates useful signals:

- suggestion selected as-is
- suggestion selected then edited
- suggestion ignored
- different topic manually selected
- new Reply Topic created

Use these signals to improve evaluation, routing, knowledge, and style before considering fine-tuning.

## Research evidence

Sweetfun historical analysis supported a controlled-reply architecture. Among high-confidence business-intent occurrences in that study:

- Fixed: ~41.5%
- Data/template style: ~39.6%
- Human Review: ~13.3%
- Generative: ~5.6%

Fixed + controlled data-inserted replies therefore covered roughly 81% of high-confidence business-intent occurrences in that research set.

Treat this as architecture evidence, not as a universal guarantee for every future property.