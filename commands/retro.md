# Workflow retro from smer

Analyze a date range (default 14d) starting with `smer brief --since RANGE --json`. Verify its candidates with timeline, `smer show`, and targeted search before concluding. Look for repeated manual command sequences, the same failure at least three times, context-switch frequency, long friction arcs from first error to resolution, and time distribution versus stated priorities.

Return no more than three suggestions. Each must include:
- the observed pattern;
- concrete event-id citations;
- likely cost, explicitly labeled as an estimate;
- one small next action;
- a way to verify improvement in later smer events.

No vibes and no generic productivity advice. If evidence is weak, say so.
