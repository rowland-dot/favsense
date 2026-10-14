# FavSense faithful knowledge cards — spec

> Status: **APPROVED — owner approved 2026-10-14 ("Approve, run overnight")**
> Version: v1.0 · Date: 2026-10-14
> Replaces: `docs/specs/archive/2026-08-22-favsense-end-to-end-organization-recovery-spec.md` (moved to the archive and marked superseded on approval)
> Evidence: `docs/reports/reviews/2026-10-14-favsense-design-assessment-review.md` (read-only design assessment)
> Visual reference: `docs/designs/2026-10-14-card-design-rewrite.html` (reviewed by the owner on 2026-10-14; cases ①, ③ and ④ approved as drawn, case ② rewritten to his correction)
> Route: after approval, `/dev-pipeline` produces and reviews the implementation plan, then builds test-first.

---

## Origin

On 2026-10-14 the owner (Ro), who took this project over from ChatGPT, saw dozens of cards on the live site labelled "证据未补齐，暂不发布" and asked why. In the same conversation he found the original of a "held" post with one search, asked why the "在小红书中查看原帖" button does not use the post link we already open for DianDian, and rejected the one-issue-at-a-time fixing that had followed his takeover: "I asked you to fix gpt's work - not for the sake of continuing its patchwork!!" A read-only assessment traced every visible failure to four design roots. This spec answers that request: rebuild how a saved note becomes a card, so that every saved note is a faithful card that opens back to its post.

## 0. The project's own principle

Every section of this spec answers to this principle, quoted from `CLAUDE.md`:

> 核心运行链路必须保持 Agent 无关。Claude 只能作为可选策展层编辑结构化 curation JSON，然后运行同一构建器；不得把用户主动触发的同步改成依赖 Claude 会话、Claude 浏览器控制或人工复制粘贴，也不得创建每日或开机整理任务。

And from `AGENTS.md`:

> - 用户主动触发的同步、去重和网页生成必须独立于 Codex、Claude、Gemini 或任何模型服务运行；不得创建每日或开机整理任务。
> - Agent 只能作为可选策展层编辑结构化 curation JSON，不能要求用户每天复制粘贴链接。

The replaced spec broke this principle in effect: a card showed its real content only after an agent session had "accepted" the note, so the optional curation layer became a mandatory gate (assessment root R1). This spec restores it: **every saved note's card is produced by a deterministic step that needs no model; an agent can only add information to a card, never decide whether the card is shown in full.**

## 1. Design derivation

1. **Problem** — Input: the notes the owner saved on Xiaohongshu (catalog title, text, author, date, collection folder, note link) plus DianDian's reply for each. Output: one card per saved note on the public site, faithful to the post and opening back to it in one click. Who benefits: the owner, who uses the site to find and reuse what he saved.
2. **Claims** —
   - *measured*: the catalog holds 377 notes, each with the token-free post link `https://www.xiaohongshu.com/explore/<id>`; none contains `xsec_token` (script count, 2026-10-14).
   - *measured*: all 377 public cards link to a Xiaohongshu search page, not the post (same day).
   - *measured*: the automatic run can only produce `pending` (`run-curation-pipeline.mjs:102–104`); only an agent-written review can produce `accepted`.
   - *measured*: every saved post text lost its paragraph breaks — 0 of the 238 notes with body text contain a line break; the cause is `fetch-xhs-details.py:144`, `" ".join(str(value).split())`.
   - *definition* (owner, 2026-10-14): a reply DianDian gives is always complete; a saved reply with missing text is our capture's fault.
   - ~~*assumption*: replies with missing text were left unfinished by DianDian~~ — killed by the owner's ruling (§2).
   - *assumption*: a token-free post link opens the post for logged-in and logged-out visitors — **untested**; decided by one live test (§6.1).
3. **Numbers** — 377 saved notes (*measured*); 238 cards with a DianDian reply, of which about 71 were saved with text missing: 22 lost text where list items join (*measured*), about 52 are cut off at the end (*estimated*: ending on a comma, colon or bare heading; spot-checked); 31 cards behind the banner (*measured*); 100 cards with an agent-rewritten title (*measured*); 78 accepted cards carrying a failed run state in their data (*measured*). The scale is hundreds of notes processed locally one at a time; nothing here is sized for throughput.
4. **Premises of anything borrowed** — Kept parts and their premises: one-page serial capture (premise: the platform's risk control punishes concurrency — holds); the pinned detail fetcher (premise: it returns the post's own text — holds, but our own cleanup erases the paragraph breaks); `site/diandian-text.mjs` formatting (premise: it removes only the chat opener and never changes the reply — holds, approved in #99); the resource verifier (premise: it is used only for "Skill" claims — holds); frozen-snapshot publishing (holds). Dropped parts: the acceptance gate, review-packet hash binding, the frozen prompt version as a merge input — their premise, "a card's content is trustworthy only after review", contradicts the principle and does not hold.
5. **What would change the answer** — If the live test shows a token-free post link does not open, the post button keeps the search entry (§6.1). If the watched DianDian run (CAP-01) shows the missing text is absent from every source including DianDian's own copy, §4 must change how the reply is obtained.

## 2. Owner rulings, 2026-10-14 (his words)

| Subject | Ruling |
|---|---|
| The 31 held cards | "They should sit well inside my 小红书收藏夹???", then chose "Show them as normal cards" |
| Card title | chose "Post's own title (Recommended)" |
| No DianDian reply | "RETRY 3 TIMES BEFORE YOU CALL IT A FAIL, THEN USE THE POST'S OWN TEXT OR ACTIVATE THE READER ENGINE TO EXTRACT WHAT'S MISSING?!!" |
| Replies with missing text | "RERUN THEM AND FIX THEM PROPERLY!! THE ISSUE IS NOT WITH DIANDIAN" |
| Are DianDian replies complete | "If diandian gives a summary it is always complete, unless you cannot get a single repsonse from diandian at all!!!" |
| Extracted text on the card | chose "Post text + extracted text (Recommended)" |
| Video download and transcription | chose "Only when needed (Recommended)" |
| Rewrite approach | chose "Replace the card path (Recommended)" |
| Which replies to re-fetch | chose "Only the ~71 damaged" |
| Post button | "since you are using the posts' links to get the diandian summaries, why didnt you save the link to the “在小红书中查看原帖” button?" |
| Design sections 1–5 | answered "Yes" to each; on the mockup: "Everything good except for 2" |

## 3. The card `[Slice: A — offline]`

### 3.1 What a card is made of

Card generation is one deterministic step. Its only inputs are the catalog record, the saved DianDian reply, the reader engine's extracted text (if any) and the optional add-on (§5.2, if any). It reads no review state and no run record.

| Part | Rule |
|---|---|
| Title | The post's own title. Without one, the first line of the post text with topic tags removed (over 52 characters: cut, with "…"). Without text either: "<author>的收藏". Agent-rewritten titles are no longer used. |
| Main text | (1) A complete DianDian reply (§4): shown with `site/diandian-text.mjs` (chat opener removed, headings and lists laid out), folded by default — the style approved in #99. (2) Otherwise the post's full text, topic tags removed, never cut, paragraph breaks kept. (3) If the post has no text beyond topic tags and the reader engine produced text, that extracted text is the main text. |
| Extracted-text section | When the reader engine ran (§5.1) and the post has its own text: a separate section after the main text, headed "视频转写与画面文字" (video) or "图片文字" (image post), shown as extracted, never rewritten by AI. |
| Source line | One line above the main text naming where it came from — "点点 AI 深度总结", "原帖公开文字", "视频转写与画面文字" or "图片文字" — with the one-sentence explanation used on the mockup. The "编辑" button sits inside this box (approved in #99). |
| Post button | Decided by §6.1: if the live test passes, "在小红书中查看原帖" opening `/explore/<id>` directly; otherwise "在小红书搜索原帖" as today. |
| Header | Collection category · content kind, author, date, and the category suggestion when the add-on supplies one — unchanged from the live site. |
| Topics and tools | Only from the optional add-on (§5.2). A tool name without a confirmed official source shows "未核实". |

Removed from every card: "证据未补齐，暂不发布" and every other run-status banner; the 240-character cut; `summaryState`, `batch_aborted`, `failed` and `stale` in public card data.

The 3 cards whose post is unreachable keep the source line approved in #99, "已完成（原帖不可访问）", with its explanation; their main text follows the table above.

### 3.2 Behaviours

| ID | Entry point | User action | Expected result |
|---|---|---|---|
| CARD-01 | Public site, card grid | Browse | All 377 cards appear; none shows "证据未补齐，暂不发布" or any other status banner |
| CARD-02 | Any card's detail view | Open it | The title equals the post's own title (or the §3.1 fallback); e.g. note `…0090ff` shows "一个人，3天，Codex，10W" |
| CARD-03 | A card with a complete DianDian reply | Open it | Source line "点点 AI 深度总结"; main text is DianDian's reply, folded, with a "展开全文 · N 字" button that reveals the whole reply |
| CARD-04 | A card whose saved reply lost text and has not been re-fetched yet | Open it | Source line "原帖公开文字" with the explanation "保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；在那之前先显示原帖自己的文字。"; main text is the post's full text |
| CARD-05 | A formerly held card (e.g. "Seedance老废片？花2W得出的提示词模板分享") | Open it | Shown as CARD-03; a tool name without a confirmed source carries "未核实" |
| CARD-06 | A video card with no DianDian reply after 3 tries, whose post has only topic tags | Open it | Source line "视频转写与画面文字"; main text is the transcript and on-screen text |
| CARD-07 | A video card with no DianDian reply after 3 tries, whose post has text | Open it | Main text is the post's full text, followed by a "视频转写与画面文字" section |
| CARD-08 | A newly captured card whose post has paragraphs | Open it | The main text keeps the post's paragraph breaks |
| CARD-09 | Public site home | Read the counts | Shows e.g. "377 条收藏 · N 条有完整点点总结 · M 条有视频转写" with real counts; "343 条完成深度解读" and "已完成视频内容核验" no longer appear |

The mockup `docs/designs/2026-10-14-card-design-rewrite.html` is authoritative for structure, placement and behaviour; styling comes from the site's own stylesheet.

## States

The card states above, named for mockup tagging (each restates a row of §3.2; no new behaviour):

- diandian: a card with a complete DianDian reply — source line "点点 AI 深度总结", reply folded with "展开全文 · N 字" (CARD-03; mockup case ①)
- damaged: a card whose saved reply lost text and has not been re-fetched — source line "原帖公开文字", main text the post's full text (CARD-04; mockup case ②)
- held: a formerly held card shown as the diandian state, with an unconfirmed tool name marked "未核实" (CARD-05; mockup case ③)
- transcript: a video card with no DianDian reply after 3 tries whose post has only topic tags — source line "视频转写与画面文字", main text the transcript and on-screen text (CARD-06; mockup case ④)
- posttranscript: a video card with no DianDian reply after 3 tries whose post has text — post text, then a "视频转写与画面文字" section (CARD-07; mockup case ⑤)
- unreachable: a card whose post is unreachable — source line "已完成（原帖不可访问）" (§3.1, last paragraph; mockup case ⑥)

## 4. Capturing DianDian's reply `[Slice: B — after the captcha hold clears]`

Root cause (owner's ruling): DianDian's reply is always complete; the missing text comes from how we read the page. Today the reply is the `innerText` of the last finished assistant message (`bridge-server.py:1821`), accepted as "stable" when two reads two seconds apart match (`:2037–2057`). Nothing checks it against DianDian's own text.

| ID | Entry point | Action | Expected result |
|---|---|---|---|
| CAP-01 | One watched DianDian run, started at a time the owner agrees to | For the same note, take three copies: the drawn page text, DianDian's own "复制" button text, and the reply data the page receives | A comparison report picks the source that matches DianDian's own text; only that source is used from then on |
| CAP-02 | Every DianDian stage | Save a reply | A save counts only when the saved copy matches DianDian's text character for character |
| CAP-03 | A non-safety failure on one note | — | Up to 3 attempts for that note; after 3 failures it is recorded as "点点未取得", queued for the reader engine (§5.1), and the run moves on to the next note |
| CAP-04 | A captcha, rate limit, `300031` or other safety signal | — | The whole run stops at once, no retry, no workaround (unchanged) |
| CAP-05 | The first run after the fix, and each run after | — | The frozen list of about 71 replies saved with missing text is re-fetched, each with the same 3-attempt limit; on success the card switches to DianDian's reply |
| CAP-06 | Fetching post details | — | Post text is saved with its line breaks; existing notes regain their paragraphs the next time their details are fetched |

The frozen list of about 71 is produced in Slice A by a one-off script from the two known damage signs (text lost where list items join; an ending on a comma, colon or bare heading), stored in the private folder, and checked entry by entry at plan review.

This section replaces the `SKILL.md` rule "任一失败都必须放弃当前及剩余点点计划并停止". One-page serial capture, the fixed prompt "总结" and stop-on-safety-signal are unchanged.

## 5. Reader engine and optional add-on

### 5.1 Reader engine `[Slice: B]`

- Runs only for notes recorded as "点点未取得": video posts are downloaded and their audio transcribed, with on-screen text read when needed; image posts have their image text read.
- Downloading is platform contact, so it happens only inside a run the owner starts, under the same safety stop; it never runs on every note by default.
- Transcription and image-text reading are offline and may run during "仅本地重建" for media already downloaded.
- Output is shown as §3.1 describes, never rewritten by AI.

### 5.2 Optional add-on `[Slice: A]`

- Content: tool and resource links, the "Skill" marker (still requiring exactly one verified resource; the resource verifier is unchanged), topic chips, the category suggestion, a content-kind override.
- Source: an agent session or the resource verifier, written by note ID into a structured file; optional.
- Constraint: it cannot change a card's title or main text and cannot hide a card. A tool name that cannot be matched to one official source is stored and shown as "未核实"; no guessed link is created.

## 6. Post link, capture completeness, counts

### 6.1 Post link `[Slice: B live test → Slice A code]`

| ID | Entry point | Action | Expected result |
|---|---|---|---|
| LINK-01 | One live test after the captcha hold clears | Open `/explore/<id>` for 3 notes, in a logged-in and a logged-out browser | Whether the post opens is recorded |
| LINK-02 | The test passes | The owner clicks a card's post button | The button reads "在小红书中查看原帖" and opens the post; public data contains `/explore/<id>` and never `xsec_token` |
| LINK-03 | The test fails | Same | The button stays "在小红书搜索原帖" and says beside it that this is a site search |
| LINK-04 | Public site or local workbench, a card whose note has an access code in the private store (`.xhs-favorites/source-codes.json`) | Open the card | The button reads "在小红书中查看原帖" and its link is `https://www.xiaohongshu.com/explore/<that note's ID>?xsec_token=…&xsec_source=…`; the card's `linkKind` is `post` |
| LINK-05 | Any card whose note has no access code, or whose code is older than the age setting `source_link.code_max_age_days` (when the domain profile has one) | Open the card | The button reads "在小红书搜索原帖" and opens the site search; `linkKind` is `search`. A code from an earlier sync still counts until the age setting says it is too old; no setting means no age limit |
| LINK-06 | The public-file check, before the build writes and before the publisher sends | Offered a signed post link | It is allowed only as the whole value of that card's own `sourceUrl`, in exactly the LINK-04 shape, for that card's own note ID; a code anywhere else (note text, another field, another card's link, any other file) and the `xsec_token` JSON key are still refused, as are cookies, the bridge token (bare or labelled), `/user/profile/` and `/board/` |

LINK-04 to LINK-06 come from the owner's ruling of 2026-10-14 (issue 106): "The rule against publishing `xsec_token` is lifted for that code only: cookies, the bridge token, profile and folder IDs, raw media and frame evidence all stay forbidden." Codes are kept only in the private store, written by the sync service from the links a sync already imports; no scheduled or start-up refresh. The code's lifetime is not yet measured, so the age setting does not exist until it is; the live test of at least five post links, logged out, right after a sync and again a day later, comes before the first publish carrying codes.

If LINK-02 holds, the public-file check before publishing (`public-tree-policy.mjs:22–23`) stops refusing `/explore/<id>` and `/discovery/item/<id>`; it still refuses `xsec_token`, profile paths `/user/profile/` and folder paths `/board/` (LINK-06 below makes the one exception for a card's own signed link). The `SKILL.md` rule at line 113, "公开网页不得把笔记 ID 拼成裸 `/explore/{id}`", is rewritten to match.

### 6.2 Capture completeness `[Slice: B]`

| ID | Entry point | Action | Expected result |
|---|---|---|---|
| COMP-01 | Local workbench, run panel | A run finishes | Each collection folder shows "已采集 N / 收藏夹共 M", with M taken from the folder page's own count (where that count appears is found by one live check; all 17 folders currently record 0) |

### 6.3 Counts and run state `[Slice: A]`

- Home-page counts follow CARD-09 and count only things that exist.
- Run state appears only in the local workbench's run panel, never in public card data.

## 7. Removal and archiving `[Slice: A]`

Removed from the card path: the acceptance gate's control of title and main text; `fallbackEntry`'s 240-character cut; the review title as card title; the builder writing run-report states into cards; the status-banner branches in `app.js` and their compensating `!accepted` checks; the separate "搜索原帖文字" concept (only if LINK-02 holds); the hidden curated `summary` on cards.

Removed from the curation layer: review-packet hash binding; the frozen prompt version as a merge input; the "a reply saved after review is not new evidence" and early-transcript exceptions; the rule that media download and transcription skip curated notes, and the switch that undoes it; the `curation_agent` config that no code reads.

Archived, not deleted: the 105 agent-written card texts; the roughly 200 hand-made batch files and 5 private scripts in `.xhs-favorites/` (including `build-agent-batch.mjs`, which marks a whole batch accepted by default) — moved to `.xhs-favorites/archive-2026-10-14/` and read by nothing.

Documents changed to match, so no two rules contradict each other: `SKILL.md`, `references/curation-standard.md`, `references/automatic-workflow.md`, `references/organization-schema.md`, `CONTEXT.md` (the "公开判定", "卡片标题" and "搜索原帖文字" entries), and the `README.md` passages describing the acceptance gate.

## 8. Boundaries that do not change

One Xiaohongshu page at a time; read-only capture; stop on any safety signal, with no retry or workaround; never read or output cookies, the bridge token, profile, folder IDs, raw media or frames; `xsec_token` only as the whole value of that card's own `sourceUrl` (LINK-04 to LINK-06), nowhere else and never read or printed by an agent; no scheduled or start-up tasks; the core chain depends on no model; frozen snapshots, at most one publish per run, never force-push; DianDian receives only the fixed prompt "总结".

Runs that drive the real mouse, and the watched live checks (CAP-01, LINK-01, COMP-01), start only at a time the owner agrees to.

## 9. Order of work and testing

**Slice A (offline; can start once this spec is approved; no Xiaohongshu contact):** §3 card, §5.2 add-on, §6.3 counts, §7 removal and archiving, the frozen damaged-reply list, and the document updates; rebuild from a frozen snapshot, publish once, and check the live cards against the mockup.

**Slice B (after the captcha hold clears):** CAP-01 watched run → LINK-01 test → COMP-01 check → §4 capture fix → CAP-05 re-fetch of about 71 replies → §5.1 reader-engine trigger → CAP-06 paragraph breaks.

| Acceptance ID | Test level | Must show |
|---|---|---|
| AC-CARD | Browser tests at desktop and phone width, on a frozen set of real cards | CARD-01 to CARD-09 each hold; one test per mockup case |
| AC-NOGATE | Builder test | Rebuilding with every review record removed leaves all 377 titles and main texts unchanged |
| AC-ADDON | Builder test | The add-on only adds topics, tools and the category suggestion; changing it never changes a title or main text |
| AC-CAP | Unit tests on real saved replies, complete and damaged | The character-for-character check rejects a damaged copy; after 3 failures the note goes to the reader engine and the run continues; a safety signal stops the run at once |
| AC-LINK | Public-file check tests | With LINK-02, `/explore/<id>` is allowed; `xsec_token`, `/user/profile/` and `/board/` are still refused |
| AC-PARA | Unit test | The detail cleanup keeps line breaks |

Existing tests that assert the acceptance gate encode the old rule; they are rewritten with this spec, not kept by working around them.

## 10. Untested — each needs one live check

1. Whether a token-free `/explore/<id>` opens the post, logged in and logged out.
2. At which step text goes missing: the drawn page, the copy button, or the received data (CAP-01).
3. Where a collection folder page shows its own saved count (COMP-01).

## 11. Approval

Approved by the owner on 2026-10-14. The replaced spec moves to `docs/specs/archive/`, marked as superseded by this one; `/dev-pipeline` starts from plan generation. Merging, publishing and real data migration follow the project's existing rules.
