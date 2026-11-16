# Business OS decision register

[Open the questionnaire](deliverable.html). [Read the canonical register](register.json). [Recorded D01-D12 answers](confirmed-history.md).

The register contains all 74 original deck decisions, unique later cascade/operational items and selected outstanding Business OS owner questions. Original IDs stay stable. Phase tags come from the source blocking-work references; Shared means not safely assignable to one phase. Original references are retained per question. This is a consolidation of reviewed evidence, not a claim that every future P0-P4 choice is already discovered.

Confirmed answers, testing defaults, unresolved choices and historical engineering follow-ups have different statuses. Implementation and merge status are independent from decision approval. Recommendations are never preselected answers. The stale historical Q29 account-switcher question is superseded by the explicit approval recorded in repository AGENTS.md; O-P0-1 records that approval. Other historical UI items need current-code review before treating them as unfinished work.

## Answering

The HTML works offline. Select a choice or enter your own answer and notes. Answers are drafts saved in this browser when storage is available. Export JSON regularly; browser storage can be cleared and is not shared between devices or with Git. Export validates custom answers and includes question IDs, option labels and register revision. Exported files can contain sensitive business decisions: do not put secrets, account numbers or passwords in answers. Paste or provide the export to an agent to reconcile into this register after Kuu confirms it. Selecting an option does not change canonical answers or project settings.

## On every phase PR and merge

1. Review affected decisions by stable ID. Add newly discovered questions here; link duplicates to existing IDs instead of assigning conflicting copies.
2. Separate assumptions/defaults from Kuu's explicit decisions. Record source, date, approver, rationale and affected phases when confirming or changing an answer; preserve superseded answers in Git history.
3. Record implementation evidence and the merged PR/commit separately. A merged implementation is not evidence that Kuu approved an unresolved policy choice.
4. Amend the same register in the PR and resolve conflicts by ID during merge. Do not overwrite main's newer decisions with a phase snapshot.
5. Run `python3 tools/build_decision_questionnaire.py`, review the generated HTML, and include register plus regenerated HTML in the same commit.
6. Sync the latest decision artifacts and confirmed answers to life-kb, and update the original owner-question queue when an answer closes it. Do not restart any runtime to edit these documents.

The PR checklist prompts this process; no automatic merge reconciler or enforced CI gate was added. Original legacy decision decks are historical evidence. This main-branch register is the maintained working copy going forward; life-kb is its shared mirror.
