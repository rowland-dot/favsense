import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Spec §7 (last paragraph): one card rule in every document. Each retired statement is gone and each new
// statement is present, so a document cannot go on teaching the gate this change removes.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const skillDir = "skills/xhs-favorites-organizer";

const contracts = {
  [`${skillDir}/SKILL.md`]: {
    retired: [
      "只有 `accepted` 条目可以写入正式 curation 与公开站点",
      "公开 `confirmed Skill` 必须是 accepted，并且恰好关联",
      "把已验证 DianDian Skill 合同的冻结 `prompt_version` 传给网页 builder",
      "不要直接运行缺少该值的底层 builder",
      "--diandian-prompt-version",
      "$promptVersion",
      "本机可通过鉴权的待审核 overlay 查看清理后的 captured 证据",
      "公开站不得直接消费 raw 点点记录",
      "明确区分“已深度整理”“使用其他证据整理”和“尚未获得深度总结”",
      // LINK-02: the post button no longer searches.
      "公开网页不得把笔记 ID 拼成裸",
      "应使用标题与作者生成小红书站内检索入口",
      "在小红书搜索原帖",
      "无 Token 的小红书站内检索入口",
    ],
    required: [
      "“在小红书中查看原帖”按钮直接打开笔记本身的无 Token 地址 `https://www.xiaohongshu.com/explore/{id}`",
      "公共文件检查仍拒绝 `xsec_token`、个人主页 `/user/profile/` 和收藏夹 `/board/`",
      "公开 confirmed Skill 恰好关联一个当前、完整、已核验的官方资源",
      "审核通过（accepted）的条目写入正式 curation，作为卡片的可选附加信息；卡片本身不受审核状态控制",
      "公开卡片展示点点回复原文（只去掉开头的对话语句），不展示其记录里的其他字段",
      "确定性的卡片步骤",
      "任一失败都必须放弃当前及剩余点点计划并停止",
      "node skills/xhs-favorites-organizer/scripts/damaged-replies.mjs --catalog",
      ".xhs-favorites/damaged-diandian-replies.json",
      "--damaged-replies",
    ],
  },
  "CONTEXT.md": {
    retired: [
      "笔记按审核条目显示时，就是审核条目自己的 `title`",
      "已通过审核的笔记只使用审核过的字段",
      "是否 accepted 及原因",
      "搜索原帖文字",
    ],
    required: [
      "不决定卡片是否完整显示",
      "原帖自己的标题，没有则取正文第一行，再没有则取作者的收藏",
    ],
  },
  "README.md": {
    retired: [
      "“待审核证据” overlay",
      "证据未补齐，暂不发布",
      "publish_only_accepted",
      "--diandian-prompt-version",
      "--diandian-report",
      "深度解读数",
      "在小红书搜索原帖",
    ],
    required: [
      "“在小红书中查看原帖”直接打开无 Token 的笔记地址",
      "公开卡片展示点点回复原文（只去掉开头的对话语句），不展示其记录里的其他字段。",
      "有完整点点总结数、有视频转写数",
    ],
  },
  [`${skillDir}/references/curation-standard.md`]: {
    retired: [
      "还必须通过 accepted/current/resource 门",
      "review_packet_sha256",
      "--diandian-prompt-version",
      "一律降级，不得发布",
      "只有正式 curation 可发布、审计完整为 `accepted`",
      "publish_only_accepted",
    ],
    required: [
      "卡片的内容形态只有在笔记恰好关联一个 fresh verified resource 时才是 `Skill`",
      "accepted` candidate 还必须保留该包的 `id` 与 `content_sha256`",
      "公开卡片直接展示已保存的点点回复全文",
    ],
  },
  [`${skillDir}/references/automatic-workflow.md`]: {
    retired: [
      "captured/pending 证据只在鉴权待审核 overlay 显示",
      "`accepted` 才能进入公开页面",
      "本地待审核 overlay",
    ],
    required: [
      "`mainText`",
      "`replyDamaged`",
      "damaged-diandian-replies.json",
      "`accepted` 才能写入正式 curation；卡片不受审核状态控制",
    ],
  },
  [`${skillDir}/references/organization-schema.md`]: {
    retired: [
      "未满足 accepted/current/resource 门",
      "额外输出 `candidateKind",
      "“标题 + 作者”的小红书站内检索入口",
      "将按钮明确标为“搜索原帖”",
    ],
    required: [
      "“在小红书中查看原帖”，直接打开 `https://www.xiaohongshu.com/explore/{id}`",
      "`mainText`",
      "`mainSource`",
      "`postUnreachable`",
      "`unverifiedTools`",
    ],
  },
};

for (const [relative, contract] of Object.entries(contracts)) {
  test(`${relative} states the one card rule`, () => {
    const document = read(relative);
    for (const phrase of contract.retired) {
      assert.equal(document.includes(phrase), false, `${relative} must no longer say: ${phrase}`);
    }
    for (const phrase of contract.required) {
      assert.equal(document.includes(phrase), true, `${relative} must say: ${phrase}`);
    }
  });
}

test("the superseded organization-recovery plan is archived and nothing still links to its old place", () => {
  assert.equal(fs.existsSync(path.join(root, "docs/plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md")), false);
  const archived = read("docs/plans/archive/2026-08-22-favsense-end-to-end-organization-recovery-plan.md");
  assert.match(archived.split("\n", 3).join("\n"), /Superseded by docs\/specs\/2026-10-14-favsense-faithful-cards-spec\.md/);
});
