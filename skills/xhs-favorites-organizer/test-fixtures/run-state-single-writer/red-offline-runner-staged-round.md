# RED: the offline evidence runner cannot find a staged round's sealed notes

Failing test: `skills/xhs-favorites-organizer/tests/test_safety_stop_offline_work.py`,
`OfflineRunnerScopeTests.test_a_staged_round_gives_the_runner_its_sealed_notes`.

Scenario: the round record is stored in the staged form (phases at the top, the sealed note list
inside the `bookkeeping` block). `run-video-analysis.ps1` is started without `-NoteId` and reads
`frozen_scope.note_ids` from the top of the file, so it finds no notes and the image text step
produces no record for the cached image.

Expected after the fix: one OCR record for the sealed note. The old single-level record keeps working
(`test_an_old_single_level_round_gives_the_runner_its_sealed_notes`).
