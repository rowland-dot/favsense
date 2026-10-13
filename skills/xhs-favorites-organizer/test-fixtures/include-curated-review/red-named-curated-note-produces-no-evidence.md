# RED: naming an accepted note for re-review produces no offline evidence (#73)

Failing tests: `skills/xhs-favorites-organizer/tests/test_review_include_curated.py`, in particular
`TranscriptionQueueTests.test_a_named_curated_note_at_the_current_version_is_queued_with_the_switch`,
`FrameQueueTests.test_a_named_curated_note_is_queued_with_the_switch_and_force`, and
`PowerShellEntryTests.test_the_switch_reaches_both_producers_only_when_it_is_turned_on`.

Scenario: the note is in the curation file at its current content version and has a cached video.
`run-video-analysis.ps1 -NoteId <id>` forwards `--note-id` to the transcriber and the frame extractor;
both skip every note already in curation, so the queue is empty and the run prints `queued: 0` without
saying why. The only way round was to hand the producers a copy of the curation file with the note removed.

Expected after the fix: `-IncludeCurated` (with `-NoteId`) reaches both producers as `--include-curated`,
the named note is queued, every named note left out is listed with its reason, and the sync service's
automatic evidence fallback never passes the switch.
