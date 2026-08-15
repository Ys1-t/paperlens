// 课题记忆工具：待办 + 短事实，跨会话持久化。

/**
 * @param {{
 *   getContext: () => { paperPath?: string, paperTitle?: string },
 *   readWorkspace: () => object | Promise<object>,
 *   writeWorkspace: (ws: object) => void | Promise<void>,
 *   store: object, // workspace-store exports
 * }} deps
 */
export function createMemoryToolDefs(deps = {}) {
  const { getContext, readWorkspace, writeWorkspace, store } = deps;

  const load = async () => store.normalizeWorkspace(await readWorkspace());
  const save = async (ws) => writeWorkspace(ws);
  const ctx = () => getContext?.() || {};

  return [
    {
      name: 'list_project_memory',
      description: '查看当前课题的未完成待办与已记要点（跨会话）。开始长任务前可先看一眼。',
      parameters: {
        type: 'object',
        properties: {
          includeDone: { type: 'boolean', description: '是否包含已完成待办，默认 false' },
        },
        required: [],
      },
      run: async ({ includeDone = false } = {}) => {
        const ws = await load();
        const { paperPath, paperTitle } = ctx();
        return {
          paperTitle: paperTitle || null,
          todos: store.listTodos(ws, { paperPath, includeDone: Boolean(includeDone) }),
          memory: store.listMemory(ws, { paperPath }),
          agentMode: ws.agentMode,
        };
      },
    },
    {
      name: 'add_research_todo',
      description: '添加一条跨会话科研待办（如「精读实验节」「核对 Table 2」）。',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待办内容' },
        },
        required: ['text'],
      },
      run: async ({ text }) => {
        const ws = await load();
        const { paperPath, paperTitle } = ctx();
        const { workspace, added, todo } = store.addTodo(ws, { text, paperPath, paperTitle });
        if (added) await save(workspace);
        return { added, todo };
      },
    },
    {
      name: 'complete_research_todo',
      description: '将待办标为完成（需提供 list_project_memory 返回的 id）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          done: { type: 'boolean', description: '默认 true' },
        },
        required: ['id'],
      },
      run: async ({ id, done = true }) => {
        const ws = await load();
        const next = store.setTodoDone(ws, id, done !== false);
        await save(next);
        return { ok: true, id, done: done !== false };
      },
    },
    {
      name: 'remember_research_fact',
      description: '记住一条短事实到课题记忆（跨会话），如「本文主指标是 HV（第 8 页）」。不要记长文。',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: '一句话事实，建议含页码' },
        },
        required: ['fact'],
      },
      run: async ({ fact }) => {
        const ws = await load();
        const { paperPath, paperTitle } = ctx();
        const { workspace, added, item } = store.rememberFact(ws, { fact, paperPath, paperTitle });
        if (added) await save(workspace);
        return { added, item };
      },
    },
  ];
}
