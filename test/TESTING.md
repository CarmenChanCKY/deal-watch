# Deal Watch — Testing

Reusable acceptance checklists, one section per milestone. Each section pairs with a runner in this folder (`TestT3.gs`, `TestT4.gs`, …).

## How to use

1. Work on a **test copy** of the Sheet, never the live one.
2. Copy the milestone runner (e.g. `TestT3.gs` in this folder) into the bound Apps Script editor as a temporary file. It is never part of the template.
3. Follow the section below top to bottom, ticking each box. `PASS/FAIL` lines from `runAllT*Checks()` map 1:1 to the boxes.
4. Finish with the Cleanup step, then **delete the runner from the editor**. The repo copy stays the source of truth for the next run.

Concepts used below: the editor's **function dropdown + Run button** (top toolbar) executes the selected no-argument function; output is read under the **Executions** (clock) icon in the left sidebar — open the latest execution to see `Logger.log` lines. Bare `return` values are NOT shown, which is why the runner logs everything it asserts. Project-level settings live under the **Project Settings** (gear) icon.

## T3

Read [T3-TestingPlan.md](T3-TestingPlan.md)

## T4

Read [T4-TestingPlan.md](T4-TestingPlan.md)

## T5

Read [T5-TestingPlan.md](T5-TestingPlan.md)

## T6

Read [T6-TestingPlan.md](T6-TestingPlan.md)

## T7

Read [T7-TestingPlan.md](T7-TestingPlan.md)

## T8

Read [T8-TestingPlan.md](T8-TestingPlan.md)
