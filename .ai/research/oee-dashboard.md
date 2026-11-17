# OEE dashboard — research

> Date: 2026-11-17
> For: `.ai/specs/2026-11-14-oee-dashboard.md`

## Question

How do OEE products compute Availability, Performance and Quality? Three
points matter for Carbon: the planned time, the ideal cycle time of a machine
that makes several products, and how to roll results up.

## Findings

| Topic | What the sources say | Sources |
|---|---|---|
| Availability | Availability = Run Time ÷ Planned Production Time. Run Time = Planned Production Time − planned and unplanned stops | Evocon, OEE.com |
| Planned time | Planned Production Time is the shift time with planned shutdowns, holidays and breaks removed. The sources do not say what happens to production outside a shift. The usual reading is that it is not planned time | Evocon, Fabrico |
| Performance, several products | Performance = Σ(ideal cycle time × total count) ÷ run time. Each product uses its own ideal cycle time. An average cycle time gives a wrong result | Parasyn, Fabrico, Abelara |
| Ideal cycle time | A Performance over 100 % usually means that the ideal cycle time is too slow | TeepTrak, Abelara |
| Roll-up | Add the parts first, then divide. A plain average of percentages is wrong. Infor weights Performance by operating time; MachineMetrics weights by scheduled time | Infor LN, MachineMetrics |
| Quality | Quality = good count ÷ total count | Evocon, OEE.com |

## What Carbon takes

1. The standard A × P × Q formulas, from sums of time and counts.
2. One ideal cycle time per operation (from the routing), so a machine that
   makes several items gets a correct Performance.
3. Run time outside the shifts. The user chose to add it to the planned time
   (decision 2026-11-17). This differs from the usual reading. Carbon shows
   that time as its own figure, "Run outside shifts", so a reader can see it.

## Sources

- https://evocon.com/kb/how-to-calculate-oee-formulas-examples
- https://www.oee.com/calculating-oee/
- https://www.fabrico.io/blog/oee-per-sku/
- https://parasyn.com.au/production-performance-implementing-oee
- https://abelara.pages.dev/tools/oee/guide
- https://teeptrak.com/en/?p=157186
- https://docs.infor.com/ln/2026.x/en-us/lnolh/tirptug/tiom01020.html
- https://docs.machinemetrics.com/docs/product-guides/understanding-your-data
