# FavSense design assessment — judged against the project's own principle

Date: 2026-10-14. Read-only assessment. No code, data, issue or git state was changed; Xiaohongshu was not contacted; no token, cookie or signed link was read.

## The principle this is measured against

From `CLAUDE.md` (line 7):

> 核心运行链路必须保持 Agent 无关。Claude 只能作为可选策展层编辑结构化 curation JSON，然后运行同一构建器；不得把用户主动触发的同步改成依赖 Claude 会话、Claude 浏览器控制或人工复制粘贴，也不得创建每日或开机整理任务。

From `AGENTS.md` (lines 7–8):

> - 用户主动触发的同步、去重和网页生成必须独立于 Codex、Claude、Gemini 或任何模型服务运行；不得创建每日或开机整理任务。
> - Agent 只能作为可选策展层编辑结构化 curation JSON，不能要求用户每天复制粘贴链接。

Restated in `skills/xhs-favorites-organizer/SKILL.md` (line 10):

> Codex、Claude 或其他 Agent 只能作为可选的二次研究者，不能成为主动同步、去重或网页数据生成的运行依赖。

And the owner's need, as given for this assessment: **a site that shows every note he saved as a faithful, useful card he can open back to the original post.**

---

## Summary

### Verdict

The pipeline obeys the principle in the letter and breaks it in effect. The button-triggered run is agent-free, but what it produces for a saved note is a degraded card. A card only becomes faithful and useful after an agent session has hand-reviewed the note and "accepted" it. The optional curation layer has become the gate on whether the owner's own saved note is shown properly. Every visible failure the owner has reported traces back to one of four design roots, not to separate bugs.

### The four roots

| # | Root | Failure classes it produces (counts measured today) |
|---|---|---|
| R1 | **One status gates two different things.** "Accepted" decides both whether a claim about a note may be published (tool identity, Skill status) and whether the note's own card is shown properly. Only an agent can produce "accepted"; the automatic run can only produce "pending". | 31 cards held behind "证据未补齐，暂不发布" while on the public site; 100 cards titled with a rewritten review title instead of the post's own; pending cards show raw hashtag text cut to 240 characters (28 of 31 carry hashtags); 105 cards show agent-written text instead of any reply; ~200 hand-made batch files and 5 private scripts outside the repo to manufacture acceptances |
| R2 | **The DianDian chat transcript is treated as complete whenever it is "finished and stable for two seconds".** Completeness is judged by shape rules added one symptom at a time. A reply already saved is never re-checked, and the summary plan skips any note that has a saved reply, so a damaged reply is never retried. | 22 reply cards with text lost where list items were joined; about 52 more reply cards cut off at the end (ending on a comma, colon or a bare heading); 71 of 238 reply cards damaged in total; earlier, 15 refusals published (#66, #69) |
| R3 | **No direct link to the post is ever stored or published.** The design treats any `/explore/<id>` link as unusable without a signed token, and the publisher refuses any public file containing a note path — although the catalog already holds the stable note ID and a token-free post URL for all 377 notes. | 377 of 377 public cards link to a Xiaohongshu *search* page keyed on the post's title and author, never the post |
| R4 | **Run bookkeeping leaks into card data, and the display layer filters it back out.** | 78 accepted cards carry "batch_aborted / failed / stale" in the public data; the site hides the label with a special case. The hero claims "343 条完成深度解读 / 已完成视频内容核验", counting 35 image notes and 163 video notes accepted on the DianDian reply alone, with no transcript |

### Recommended direction

Split the card from the claims, then delete machinery rather than add it.

- **The card** — title, author, date, board, the post's own text, a complete DianDian reply when one exists, and a link to the post. It is a deterministic projection of the catalog plus the saved reply. The button run produces it for every saved note with no agent and no acceptance step. That is what the principle already asks for.
- **The claims** — tool and resource links, "Skill" status, curated notes. These stay an optional overlay that may add to a card and never hides or degrades one. An unconfirmed name is shown as unconfirmed.
- **The link** — one live test, once the captcha hold is cleared, decides the post-link form. The ban on note paths in the publisher is then lifted or kept on that evidence.
- **The spec** — the governing spec (`docs/specs/archive/2026-08-22-favsense-end-to-end-organization-recovery-spec.md`) encodes R1 (§5.6, §5.8, §8.1 "publish_only_accepted 质量门"). It needs rewriting before code changes, not working around. #101 is already on hold for this reason and should stay held.

---

## How this was measured

**Read in full:**
- `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `README.md`.
- `SKILL.md` and the four prose references (`automatic-workflow.md`, `curation-standard.md`, `organization-schema.md`, `xhs-downloader-adapter.md`).
- `docs/ARCHITECTURE.md` and the governing spec above.
- Every script in the path from capture to published card: the userscript template, `bridge-server.py` (all 7,319 lines), `fetch-xhs-details.py`, `download-pending-media.py`, `transcribe-pending-videos.py`, `extract-pending-frames.py`, `extract-pending-image-text.py`, `cached_images.py`, `run-video-analysis.ps1`, `run-daily.ps1`, `organize.mjs`, `platform_access.py`, `organization_state.py`, `diandian_refusal.py` / `.mjs`, `content-revision.mjs`, `curation-revision.mjs`, `normalize-evidence.mjs`, `generate-curation-candidates.mjs`, `initialize-curation-audit.mjs`, `prepare-curation-scope.mjs`, `prepare-curation-review.mjs`, `merge-curation-results.mjs`, `validate-curation.mjs`, `curation-quality.mjs`, `run-curation-pipeline.mjs`, `public-judgement.mjs`, `category-policy.mjs`, `resource-quality.mjs`, `verify-github-resources.mjs`, `evidence-stats.mjs`, `sensitive-data.mjs`, `build-public-site.mjs`, `build-organization-snapshot.mjs`, `public-tree-policy.mjs`, `publish-huggingface.mjs`, `site/app.js`, `site/diandian-text.mjs`.
- The five private helper scripts in `.xhs-favorites/`.

**Analysed with scripts, not read line by line** (they are data files):
- `skills-board-curation.json` (18,486 lines)
- `software-resources.json` (2,105 lines)

**Not read** (storage, locking and setup plumbing that does not decide card content):
- `journaled-transaction.mjs`, `organization-mutation-lock.mjs`, `migrate-organization-state.mjs`, `worktree-base.mjs`
- the five setup/start/stop PowerShell scripts, `preload-transcription-model.py`
- `site/local-bridge-utils.mjs`, `resource-utils.mjs`, `personal-store.mjs`, the two `hf-*` modules, `styles.css`
- the 124 test files (about 43,000 lines)

**Counts.** Every count below was measured today by scripts run against:
- `site/data/knowledge.json` (built 2026-10-13 18:15 UTC, 377 notes)
- `.xhs-favorites/catalog.json`
- `.xhs-favorites/curation-audit.json`
- `.xhs-favorites/diandian-rerun-report.json`
- the 292 saved replies in `.xhs-favorites/diandian-summaries/`

**Issue history.** GitHub issues #4–#101 were listed; the bodies of #74, #84, #99 and #101 were read. In five days (2026-10-09 to 10-14), 47 pull requests were merged, nearly all one-symptom fixes.

---

## The four owner-visible failures, traced to their roots

### 1. Every card links to a search page, never the post (R3)

**What the design assumes:**
- `SKILL.md:113` forbids "把笔记 ID 拼成裸 `/explore/{id}`" and requires a "搜索原帖" search entry instead.
- The reason given is `organization-schema.md:28`: "裸 `/explore/{id}` 直达链接**可能**因缺少临时签名而失效". That is a guess about usability.
- It is enforced as if it were a privacy rule. `public-tree-policy.mjs:22–23` makes the publisher refuse any public file that contains `xiaohongshu.com/(user/profile|board|explore|discovery/item)/`. So even a token-free post link can never be published.

**What the catalog already keeps:**
- All 377 catalog entries hold the stable note ID and the token-free post URL `https://www.xiaohongshu.com/explore/<id>` (field `url`, written by `organize.mjs:203` and `fetch-xhs-details.py:234`).
- No signed token is kept, correctly.
- The same codebase uses those plain URLs as download input elsewhere (`download-pending-media.py:183`). The project is not consistent about whether a plain link works.

**What the site does instead:**
- `build-public-site.mjs:119–125` builds `search_result?keyword=<post title> <author>` for every card (377 of 377).
- The keyword comes from the post's title for 350 cards and from its description for the 27 posts that have no title.
- A search is not an identifier. Whether it finds the post was never tested (#74 triage says so).
- `CONTEXT.md` had to define a separate "搜索原帖文字" just to stop the rewritten card title from being used as the search term.

**The local "打开原帖":**
- It opens the source board in the scan browser and scrolls until the note appears (userscript `openRequestedNote`, up to 5 minutes).
- That works, but it is a platform action the design exempts from its own definition of platform contact.

**What a correct design keeps:** the note ID (already kept), plus one link form chosen by evidence. **Untested, and needs a live check:**
- whether the plain `/explore/<id>` link opens the post for a logged-in viewer and for a logged-out one;
- whether the share link from "复制链接" stays valid over time;
- whether the current search entry finds the post at all.

**Shares its root with:** the rewritten-title problem in failure 3. The search term had to be separated from the card title only because the link is a search.

### 2. 31 cards withheld behind "证据未补齐，暂不发布" (R1)

**The mechanism:**
- A card shows its reply or reviewed text only if its review status is `accepted` (`public-judgement.mjs:142–153`, `curation-quality.mjs:324–342`). Otherwise it gets `fallbackEntry`: the post description cut to 240 characters (`public-judgement.mjs:101–106`).
- `app.js:517–521` then labels the card "证据未补齐，暂不发布", on a card that is published.

**Why no automatic run can ever clear it:**
- The final build's curation step, run by the button, marks every note not already accepted as pending. The code says so plainly: `run-curation-pipeline.mjs:102–104`, where no review step means `status: "pending"`.
- Acceptance can only come from `merge-curation-results.mjs`, fed by a review an agent writes. That review needs review-packet hashes, a frozen prompt version only the Bridge can produce, and evidence binding.
- So the "optional" curation layer decides whether a saved note is shown properly. That breaks the principle's intent.

**Who is held today:**

| Why held (audit reason) | Cards |
|---|---|
| A named tool, project or site could not be matched to one official page | 23 |
| Image note with no readable image text | 2 |
| Thin or cut-off body evidence | 6 |

- 29 of the 31 already have a saved DianDian reply that is not shown.
- 28 of them show raw `#…[话题]#` hashtag text.

**The documents contradict each other three ways:**
- `SKILL.md:107` tells curators: "事实不充分时必须写“待确认”".
- The validator refuses that word in any accepted text (`validate-curation.mjs:15`, `/尚未完整解读|待确认/`).
- `curation-standard.md:73` says an uncertain fact keeps the note `pending` and "不对外发布". `SKILL.md:158` says pending "不得发布".
- Yet `curation-standard.md:185` says every synced note "仍以安全 fallback 显示", and the site does publish them.

There is no legal path for "show the note, mark the name unconfirmed". The owner's ruling of 2026-10-14 (#101) asks for exactly that path.

**Shares its root with:** rewritten titles, hashtag text, the hidden replies, and the shadow review tooling (see failure 4).

### 3. Card text that does not match its post, or is damaged

| Class | Cards | Root | Evidence |
|---|---|---|---|
| Reply with text lost where list items were joined | 22 | R2 | Rule `[。，：！]- ` applied to public reply text. The same damage is in the saved records (25 of 292). The rule runs at capture only (`bridge-server.py:5493`, `:5598`). `automatic-workflow.md:65` says saved replies are deliberately not re-checked. |
| Reply cut off at the end (ends on a comma, colon, or a bare heading such as "核心亮点", "4K的优势") | ≈52 (heuristic; spot-checked) | R2 | Example endings: "比完结果再合并赢家，", "完整地址在笔记评论区，". No rule catches this class at all. |
| Damaged in either way (union) | 71 of 238 reply cards | R2 | — |
| Title rewritten by the reviewer, so it differs from the post's own title | 100 | R1 | `build-public-site.mjs:106–109` uses the review entry's `title` for any accepted note. #74 made this deliberate, and #79 and #87 then had to fix bad review titles. |
| Post has no title, so the card title is made up from the description or the review | 27 | R1 / R3 | — |
| Pending card shows raw hashtag text cut at 240 characters | 28 | R1 | `public-judgement.mjs:101–106` |
| Accepted card shows agent-written text instead of any reply (DianDian refused, damaged or never captured) | 105 (97 video, 8 image) | R1 | Text written in hand batches; the five copied-text rules in `validate-curation.mjs:26–61` (#86) exist because this text used to be pasted in. |
| Accepted card carries a failure run state in its data (batch_aborted 75, failed 2, stale 1) | 78 | R4 | `build-public-site.mjs:250–256` copies states from a stale private run report; `app.js:523–533` hides them with `!accepted`. This is the "large group wrongly labelled as failed". |
| Opening chat line still shown after display stripping | 1 | R2 | `site/diandian-text.mjs` strips only an opener paragraph that ends in "：" or "。". |

**Why R2 happens:**
- The capture takes the `innerText` of the last finished assistant message (`bridge-server.py:1821`). It accepts the reply if two reads two seconds apart agree (`:2037–2057`).
- Nothing checks that the reply is complete.
- `valid_diandian_record` (`:768`) excludes refusals but not damaged replies. The summary plan skips every note with such a record (`:4330`), so a damaged reply is never retried.
- Whether the text is lost inside DianDian or in the page read is **untested**. #84 asks for one watched live capture to find out.

**Checked and not found:** a reply describing a different post. Comparing the post's text with its reply flagged 4 cards with low overlap, and on reading, all 4 match their posts. No curated summary still opens with copied post text.

**Shares its root with:** the 15 refusals published earlier (#66), the 1-byte record (#75), and the "unstable reply" stops. All are the same "shape rule after the fact" pattern.

### 4. Where the design produces a wrong or misleading card, or a rule exists only to work around another rule

**Misleading headline numbers (R4)**
- `meta.videoMethod` reads "343 条收藏已完成视频内容核验", and the hero shows "343 条完成深度解读".
- The 343 are simply the accepted notes (`build-public-site.mjs:306`, `:330`).
- They include 35 image notes, and 163 video notes accepted with the DianDian reply as their only body evidence, with no transcript. `SKILL.md:119–123` requires audio first for videos.
- "9,630 张可复核画面" counts frame files from 49 notes; the public cannot see them.

**Capture completeness is unverified**
- All 17 boards in the private config record `advertised_count: 0`: the userscript's count parsing fails.
- An incremental scan reads at most 60 notes per board, a history scan 200.
- The system cannot tell the owner whether every saved note is in the catalog. Whether boards hold more than was captured is **untested**.

**The declared agent route cannot produce acceptances, so a shadow route grew**
- The declared route (`SKILL.md:105`): edit `references/*-curation.json`, then run a local rebuild.
- That cannot produce an accepted card: the merge requires review-packet hashes and a Bridge-frozen prompt version.
- So sessions built a shadow route: about 200 hand-made scope, review and evidence files in `.xhs-favorites/` (`agent-batch-01…18`, `pending-*`, `rejected-*`, `issue86-*` …), plus five private scripts outside the repository.
- One of them, `build-agent-batch.mjs`, sets every note in a batch to accepted unless told otherwise. Line 56: `const status = override.status || "accepted";`. It also sets `claims_supported` and `resource_status: "verified"` from that default (lines 63–64).
- The "semantic review" gate is therefore partly ceremonial. The hashing that guards it binds files, not judgement.

**Rules that exist only to work around another rule**

| Workaround | The rule it works around |
|---|---|
| `app.js:516–533`, the `!accepted &&` guards | The builder writing run states into card data |
| "已保存的回复不用这条规则复查" (`automatic-workflow.md:65`) and the #84 ruling to keep 22 damaged replies public | Applying the rule to saved replies would flip accepted cards to agent text under R1 |
| `bridge-server.py:6714–6723`: a reply saved after review "is not new evidence", plus the early-transcript exception at `:6698–6707` | Revision binding would otherwise un-accept notes whenever new evidence arrives |
| Media download skips curated notes (`:2161`); the transcriber skips them too; `-IncludeCurated` was added (#73) to undo that for re-reviews | Evidence collection keyed to the acceptance state |
| `CONTEXT.md` "搜索原帖文字" separated from "卡片标题" | The card title being the rewritten review title (R1) while the link is a search (R3) |
| The five copied-text rules in the validator (#86), and the 30-plus refusal and incomplete case tables kept in two languages | Agent-written text being required for acceptance but pasted from the reply it replaces |
| `curation_agent` block in the private config | Read by no code |

**Weight**
- The chain is about 19,700 lines of scripts plus 43,000 lines of tests.
- Much of it is file-identity, lock and hash-binding machinery whose purpose is to keep the acceptance gate consistent. None of it makes a card more faithful.

---

## Stage by stage

"Principle" means agent-independent sync, dedupe and web generation, with agents optional. "Need" means every saved note shown as a faithful card that opens the post.

| Stage | Obeys principle? | Serves need? | Evidence | What it should be instead |
|---|---|---|---|---|
| **Capture** (userscript board scan → Bridge import) | Yes | Partly | Agent-free, one page, safety stop works. Board counts are 0 for all 17 boards, so completeness is unknowable; incremental scan caps at 60 per board. | Keep. Record each board's own saved count and report "captured / saved" (needs a live check of where the count appears). |
| **Detail fetch** (pinned XHS-Downloader) | Yes | Yes | Writes title, description, tags, author, date and the token-free post URL for 377 of 377 notes. | Keep unchanged. |
| **DianDian summary** | Yes | No | 71 of 238 published replies damaged. Completeness is judged by symptom rules; saved replies are never re-checked or retried (`bridge-server.py:768`, `:4330`). | One completeness check, at capture and on read. A failing reply is re-queued and the card falls back to the post's text. Find the loss point with the one live capture #84 asks for. |
| **Video and image evidence** (media download, transcription, OCR, frames) | Yes | Not used by cards | Transcripts and OCR feed only the acceptance gate; no card shows them. 163 accepted videos have no transcript. Skips curated notes, then needs flags to undo the skip. | Optional evidence for the claims overlay, run on demand. Card generation must not wait on it. |
| **Curation review** (scope → candidates → review packet → audit → merge → validate) | **No, in effect** | No | The automatic run can only write `pending` (`run-curation-pipeline.mjs:102–104`). Acceptance needs an agent and a shadow toolchain. The optional layer decides whether the owner's own note is shown properly. | An optional annotation layer keyed by note ID and content revision: curated notes, unconfirmed names marked "未核实", resource links. No packet or prompt-version binding is needed to annotate. Cards never wait on it. |
| **Public judgement** | No | No | `judgePublicNote` decides title, text and status from acceptance. Non-accepted notes get the 240-character fallback. | Splits in two: (a) a deterministic card projection from the catalog plus the saved reply; (b) a claims judgement that only decides resource links and "Skill" status. |
| **Site build** | Yes (agent-free) | No | Copies stale run states into 78 accepted cards; writes headline claims that are not true ("343 已完成视频内容核验"). | Write no run state into public data. Counts say what they count: "377 saved notes · N with a complete DianDian summary". |
| **Card display** (`app.js`) | n/a | No | A "暂不发布" banner on published cards; guards hiding builder output; rewritten titles; hashtag text. | Show the post's title, then the complete reply or the post's text, with a one-line source label and no status banners. Delete the compensating branches. |
| **Original-post link** | n/a | No | Search link on 377 of 377 cards. The publisher bans note paths outright (`public-tree-policy.mjs:22–23`). | Choose the link form by live test (Decision 5). Then align the publisher's ban with what the evidence shows. |
| **Publish** (frozen snapshot → HF Space) | Yes | Yes | One publish per run, from a frozen snapshot, never a force push. | Keep. Only the note-path ban changes, if Decision 5 allows it. |

---

## What to remove, what to keep

**Remove from the card path** (each item traces to R1, R2 or R4):
- the `accepted` gate on card text and title;
- `fallbackEntry`'s 240-character cut;
- the review title as the card title;
- run-report states in public data;
- the status-banner branches in `app.js` and their compensating guards;
- the separate "搜索原帖文字" concept, once the link is direct;
- the hidden curated `summary` field on cards that show the reply.

**Remove or narrow in the curation layer:**
- review-packet hash binding;
- the frozen prompt version as a merge input;
- the early-transcript and "summary saved after review" exceptions;
- the curated-notes skip in media and transcription;
- the dead `curation_agent` config.

The claims overlay needs a note ID, a content revision and a verified resource — nothing more.

**Keep:**
- one-page, user-triggered capture;
- the safety stop and the platform-access module;
- the pinned detail fetcher;
- the stable note-ID catalog;
- the one-time DianDian capture with a single completeness check;
- the resource verifier, for "Skill" claims only;
- privacy scanning of the public tree, minus the note-path ban if Decision 5 allows;
- frozen-snapshot publishing.

---

## Not tested — each needs one live check after the captcha hold clears

1. Whether a plain `https://www.xiaohongshu.com/explore/<id>` link opens the post, logged in and logged out.
2. Whether a "复制链接" share link stays valid after days.
3. Whether the current search link finds the post.
4. Whether DianDian's lost text is in DianDian's own reply or in the page read (#84).
5. Where a board shows its saved count, so capture completeness can be checked.

---

## Decisions only the owner can make

### Decision 1 — Is every saved note a full card, whatever its review state?
- **A.** Yes. The card is built from the post and any complete DianDian reply; review only adds claims. *(Recommended — what the principle and the #101 ruling already point to.)*
- **B.** Only for the 31 held today (#101 as written), keeping the acceptance gate for future notes.
- **C.** Keep the gate.

### Decision 2 — Card title
- **A.** The post's own title; where the post has none, the first line of its text. *(Recommended — the owner recognises his saved note by it, and 100 cards differ today.)*
- **B.** The reviewer's rewritten title.
- **C.** Post title with the reviewer's title as a subtitle.

### Decision 3 — Card text when there is no complete DianDian reply
- **A.** The post's own text, cleaned of hashtags and shown whole. *(Recommended — faithful, agent-free.)*
- **B.** Agent-written curated text where it exists (105 today), otherwise the post's text.
- **C.** Both.

### Decision 4 — The 71 damaged replies until re-summarised
- **A.** Show the post's text on the card and keep the damaged reply in the detail, labelled "点点回复不完整". *(Recommended.)*
- **B.** Keep showing them as now (the #84 ruling covers the 22).
- **C.** Hide the reply entirely.

### Decision 5 — Form of the original-post link (after one live test)
- **A.** Plain `/explore/<id>` if the test shows it opens. *(Recommended first test.)*
- **B.** The "复制链接" share link, which carries a token meant for sharing — publishing it is a privacy call only the owner can make.
- **C.** Keep the search link.

### Decision 6 — The curation and acceptance machinery
- **A.** Cut it back to an optional claims overlay and delete the binding and hashing machinery around card display. *(Recommended.)*
- **B.** Keep it and add the #101 branch.
- **C.** Remove curation entirely.

### Decision 7 — Media download and transcription in the button run
- **A.** On demand only, for notes being annotated. *(Recommended — it feeds no card, and every download is platform contact.)*
- **B.** Keep automatic.

### Decision 8 — How the rewrite proceeds
- **A.** Rewrite the 2026-08-22 spec through the project's spec route, opening with the principle above, then plan, then build. Keep #101 and #84 on hold until then. *(Recommended.)*
- **B.** Proceed issue by issue.

### Decision 9 — Capture completeness
- **A.** Add a "captured / saved" check per board once the live check finds where the count lives. *(Recommended.)*
- **B.** Accept unknown completeness.
