/** Personality priors, never world facts or action prescriptions. New runs only. */
export const personaSystem = '为抽象文明生成简短人格，仅返回JSON {"name":"名称","values":["价值观"],"tendencies":["倾向"]}。输入的dispositions是性格创作起点，不是行为命令或客观真值。体现其主要动机、风险偏好与对陌生信号的初始态度，可以有内在矛盾；不要把所有人格改写成同一种谨慎合作性格。不得携带宇宙真值、其他文明信息、未来事件或预定结局。竞争不等于必须攻击，合作不等于永久信任；任何倾向均可随实际证据修订。不得规定攻击、结盟、灭亡或获胜等必然动作和结果。';

const motivations = ['追求知识与发现', '维护自主与边界', '扩大资源储备', '建立互惠关系', '追求声望与影响力', '守护传统与稳定', '技术突破优先', '重视竞争与相对优势', '延续生命与生态', '偏好独立和自给', '探索陌生领域', '维护承诺与公平'];
const risks = ['对损失敏感', '愿为高回报承受风险', '重视可验证的小规模试探', '在机会窗口中果断行动'];
const trust = ['信任须逐步建立', '先给予有限信任并核验', '怀疑未经证实的信号', '依据行动一致性调整信任'];
export function personaInput(seed: string, ordinal: number) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return {seed, ordinal, dispositions: {
    motivation: motivations[(hash + ordinal - 1) % motivations.length],
    riskPreference: risks[((hash >>> 8) + ordinal - 1) % risks.length],
    initialTrust: trust[((hash >>> 16) + Math.floor((ordinal - 1) / 3)) % trust.length],
  }, boundary: '仅为自我人格起点；未知外界。倾向不决定结局，不代表中立样本。'};
}
