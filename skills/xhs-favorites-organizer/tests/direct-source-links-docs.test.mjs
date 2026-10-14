import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Issue 106: the owner lifted the rule against publishing `xsec_token` for one use only, the signed link of a
// card's own post. Every document that states the rule states that narrowed rule (and nothing wider): the old
// absolute wording is gone, the one allowed use is named, and what stays forbidden is still said.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const skillDir = "skills/xhs-favorites-organizer";

// The one clause every rule line carries, so no two documents can drift into different versions of the rule.
const ALLOWED_USE = "只能作为该卡片自己 `sourceUrl` 的整个值";
const SPEC_ALLOWED_USE = "only as the whole value of that card's own `sourceUrl`";

const contracts = {
  "AGENTS.md": {
    retired: ["不读取、导出、打印或提交 Cookie、`xsec_token`、bridge token"],
    required: [ALLOWED_USE, "Cookie", "bridge token", "个人主页", "收藏夹 ID", "原始视频", "帧证据", ".xhs-favorites/source-codes.json"],
  },
  "CLAUDE.md": {
    retired: ["不得把 `xsec_token`、Cookie 或浏览器会话信息写入任何文件或回复"],
    required: [ALLOWED_USE, "不得把 Cookie 或浏览器会话信息写入任何文件或回复", ".xhs-favorites/source-codes.json"],
  },
  "SECURITY.md": {
    retired: ["`xsec_token` 只允许短暂存在于内存和子进程 stdin，不得写入日志或公开 JSON"],
    required: [ALLOWED_USE, "Cookie", "bridge token", "个人主页", "收藏夹 ID", ".xhs-favorites/source-codes.json"],
  },
  [`${skillDir}/SKILL.md`]: {
    retired: [
      "也不得发布会过期的 `xsec_token`",
      "不把登录 Cookie 或 `xsec_token` 写入文件",
      "也不得持久化签名链接，因此只能显示按标题与作者生成的",
    ],
    required: [
      ALLOWED_USE,
      ".xhs-favorites/source-codes.json",
      "FavSense 代码不读取、导出、复制、打印或提交 Chrome Cookie",
      "公开网页不得把笔记 ID 拼成裸 `/explore/{id}`",
      "在小红书中查看原帖",
      "在小红书搜索原帖",
      "`linkKind`",
      "source_link.code_max_age_days",
    ],
  },
  [`${skillDir}/references/organization-schema.md`]: {
    retired: ["公开数据又不得保存 `xsec_token`。因此公开网页使用“标题 + 作者”的小红书站内检索入口，并将按钮明确标为“搜索原帖”"],
    required: [ALLOWED_USE, "`linkKind`", "在小红书中查看原帖", "在小红书搜索原帖", "不写入 catalog"],
  },
  [`${skillDir}/references/xhs-downloader-adapter.md`]: {
    retired: ["输出不得包含原始查询参数、`xsec_token` 或 Cookie。Bridge 只接收"],
    required: [ALLOWED_USE, "输出不得包含原始查询参数、`xsec_token` 或 Cookie", "Bridge 只接收成功详情与脱敏失败分区"],
  },
  "README.md": {
    retired: ["公开/Hugging Face 页面不保存签名链接，因此显示安全的“在小红书搜索原帖”入口。"],
    required: ["在小红书中查看原帖", "在小红书搜索原帖", ".xhs-favorites/source-codes.json"],
  },
  "CONTEXT.md": {
    retired: [],
    required: ["**来源链接有效期**", "`source_link.code_max_age_days`", "唯一解析函数"],
  },
  "docs/specs/2026-10-14-favsense-faithful-cards-spec.md": {
    retired: ["never read or output cookies, `xsec_token`, the bridge token, profile, folder IDs, raw media or frames"],
    required: [
      SPEC_ALLOWED_USE,
      "| LINK-04 |",
      "| LINK-05 |",
      "| LINK-06 |",
      "never read or output cookies, the bridge token, profile, folder IDs, raw media or frames",
    ],
  },
};

for (const [relative, contract] of Object.entries(contracts)) {
  test(`${relative} states the narrowed rule for the access code`, () => {
    const document = read(relative);
    for (const phrase of contract.retired) {
      assert.equal(document.includes(phrase), false, `${relative} must no longer say: ${phrase}`);
    }
    for (const phrase of contract.required) {
      assert.equal(document.includes(phrase), true, `${relative} must say: ${phrase}`);
    }
  });
}
