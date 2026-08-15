// 投稿助手（纯函数）：会议 DDL 倒计时、常见 venue 预设、投稿前检查清单模型。
// venue 数据存 workspace.venues（workspace-store 规范化）；这里管展示与推导。

/** 距离截稿的倒计时模型。deadline 是 'YYYY-MM-DD'（AoE 近似：当天 23:59 UTC-12）。 */
export function deadlineCountdown(deadline, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(deadline || '').trim());
  if (!m) return null;
  // AoE = UTC-12：截稿日 23:59:59 AoE == 次日 11:59:59 UTC
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 11, 59, 59);
  const ms = end - now;
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return {
    passed: ms < 0,
    days: Math.abs(days),
    hours: Math.abs(hours),
    urgency: ms < 0 ? 'passed'
      : days <= 3 ? 'critical'
        : days <= 14 ? 'soon'
          : days <= 45 ? 'normal' : 'far',
    label: ms < 0
      ? `已截稿 ${Math.abs(days)} 天`
      : days === 0 ? `今天截稿（剩 ${hours} 小时 AoE）`
        : `剩 ${days} 天`,
  };
}

/** venue 列表 → 展示模型（按截稿由近到远，过期沉底）。 */
export function venueBoardModel(venues, now = Date.now()) {
  const rows = [];
  for (const venue of Array.isArray(venues) ? venues : []) {
    const countdown = venue.deadline ? deadlineCountdown(venue.deadline, now) : null;
    rows.push({ ...venue, countdown });
  }
  rows.sort((a, b) => {
    const ap = a.countdown?.passed ? 1 : 0;
    const bp = b.countdown?.passed ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const ad = a.deadline || '9999-99-99';
    const bd = b.deadline || '9999-99-99';
    return ad.localeCompare(bd);
  });
  return rows;
}

/**
 * 常见 AI/CS 会议预设（**截稿日期逐年变化，添加时务必自行核对官网**）。
 * deadline 留空 —— 预设只帮用户少打字，不假装知道今年的日期。
 */
export const VENUE_PRESETS = Object.freeze([
  { abbr: 'NeurIPS', name: 'Conference on Neural Information Processing Systems', url: 'https://neurips.cc' },
  { abbr: 'ICML', name: 'International Conference on Machine Learning', url: 'https://icml.cc' },
  { abbr: 'ICLR', name: 'International Conference on Learning Representations', url: 'https://iclr.cc' },
  { abbr: 'AAAI', name: 'AAAI Conference on Artificial Intelligence', url: 'https://aaai.org' },
  { abbr: 'IJCAI', name: 'International Joint Conference on AI', url: 'https://ijcai.org' },
  { abbr: 'CVPR', name: 'IEEE/CVF Computer Vision and Pattern Recognition', url: 'https://cvpr.thecvf.com' },
  { abbr: 'ICCV', name: 'International Conference on Computer Vision', url: 'https://iccv.thecvf.com' },
  { abbr: 'ECCV', name: 'European Conference on Computer Vision', url: 'https://eccv.ecva.net' },
  { abbr: 'ACL', name: 'Annual Meeting of the ACL', url: 'https://www.aclweb.org' },
  { abbr: 'EMNLP', name: 'Empirical Methods in NLP', url: 'https://2026.emnlp.org' },
  { abbr: 'KDD', name: 'ACM SIGKDD', url: 'https://kdd.org' },
  { abbr: 'WWW', name: 'The Web Conference', url: 'https://www2026.thewebconf.org' },
  { abbr: 'SIGIR', name: 'ACM SIGIR', url: 'https://sigir.org' },
  { abbr: 'GECCO', name: 'Genetic and Evolutionary Computation Conference', url: 'https://gecco-2026.sigevo.org' },
  { abbr: 'TEVC', name: 'IEEE Trans. Evolutionary Computation（期刊·随时投）', url: 'https://cis.ieee.org' },
  { abbr: 'TPAMI', name: 'IEEE TPAMI（期刊·随时投）', url: 'https://www.computer.org/csdl/journal/tp' },
]);

/** 投稿前检查清单（静态模型；勾选状态存 UI 层）。 */
export const SUBMISSION_CHECKLIST = Object.freeze([
  { id: 'story', label: '贡献表述', desc: '摘要/引言的 2–3 条贡献是否与实验证据一一对应' },
  { id: 'related', label: '相关工作', desc: '最近 12 个月同方向工作是否覆盖（用前沿雷达/文献调研核对）' },
  { id: 'repro', label: '可复现性', desc: '超参数、随机种子、代码/数据可用性声明' },
  { id: 'ablation', label: '消融完整', desc: '每个组件都有对应消融或引用支撑' },
  { id: 'stats', label: '统计显著', desc: '多次运行方差 / 显著性检验（若领域惯例要求）' },
  { id: 'limitations', label: '局限性', desc: 'Limitations / Broader Impact 小节（会议若要求）' },
  { id: 'format', label: '格式合规', desc: '页数上限、模板年份、匿名要求、引用格式' },
  { id: 'ethics', label: '伦理声明', desc: '人类数据 / 许可证 / 伦理审查（如适用）' },
]);
