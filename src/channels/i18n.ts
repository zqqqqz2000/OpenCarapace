export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "en";

export function resolveLocale(value: string | undefined): Locale {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "en") {
    return "en";
  }
  return "zh";
}

type Messages = {
  // Turn relay progress
  taskError: (error: string) => string;
  noReadableResult: string;
  fullResponseCaption: string;
  processing: (preview: string) => string;

  // Running control
  locatedRunningMessage: string;
  taskFailed: (reason: string) => string;

  // Turn decision prompt
  turnDecisionHeading: string;
  turnDecisionBody: string;
  turnDecisionSteer: string;
  turnDecisionStack: string;
  turnDecisionHeadingHtml: string;
  turnDecisionSteerHtml: string;
  turnDecisionStackHtml: string;

  // Turn decision response messages
  noPendingDecision: string;
  decisionExpired: string;
  steerSelected: string;
  stackSelected: (queue: string) => string;
  stackQueueHeader: string;

  // Session picker
  sessionOptionExpired: string;
  sessionOptionWrongConversation: string;
  sessionSelectionInvalid: string;
  sessionSelected: (name: string) => string;
  sessionSendNewName: string;
  sessionSendCancel: string;

  // Rename picker
  renameOptionExpired: string;
  renameOptionWrongConversation: string;
  renameNameEmpty: string;
  renameNameInvalid: string;
  renameTargetMissing: string;
  renameSuccess: (oldName: string, newName: string) => string;

  // Project picker
  projectOptionExpired: string;
  projectOptionWrongConversation: string;
  projectSelectionInvalid: string;
  projectSwitched: (name: string) => string;
  projectSendNewName: string;
  projectSendCancel: string;
  projectNameEmpty: string;
  projectNameInvalid: string;
  projectNameTraversal: string;
  projectAlreadyExists: (name: string) => string;
  projectCreateFailed: (error: string) => string;
  projectCreated: (name: string) => string;
  projectRootNotConfigured: string;
  noRenamableSessions: string;

  // Picker UI labels
  prevPage: string;
  nextPage: string;
  morePage: string;
  createProject: string;
  currentProject: (name: string) => string;
  sessionPickerHeader: (project: string) => string;
  renamePickerHeader: string;
  sandboxPickerHeader: string;
  modelPickerHeader: string;
  depthPickerHeader: string;
  projectPickerHeader: (current: string, hasProjects: boolean) => string;

  // Input validation
  positiveIntegerRequired: string;
  inputCancelled: string;
};

const ZH: Messages = {
  taskError: (error) => `任务执行出错：${error}`,
  noReadableResult: "暂无可读结果，请重试。",
  fullResponseCaption: "完整版回复（文本附件）",
  processing: (preview) => `处理中：${preview}`,

  locatedRunningMessage: "已定位当前 running 消息。",
  taskFailed: (reason) => `任务执行失败：${reason}`,

  turnDecisionHeading: "检测到你发送了新消息",
  turnDecisionBody: "当前任务仍在运行，请选择处理方式：",
  turnDecisionSteer: "1. steer：中断当前任务并切换到新消息",
  turnDecisionStack: "2. stack：保持当前任务，新消息进入队列",
  turnDecisionHeadingHtml: "<b>检测到你发送了新消息</b>",
  turnDecisionSteerHtml: "1. <b>steer</b>：中断当前任务并切换到新消息",
  turnDecisionStackHtml: "2. <b>stack</b>：保持当前任务，新消息进入队列",

  noPendingDecision: "当前没有待决策的新消息，请直接发送新消息。",
  decisionExpired: "这个选项已过期，请按最新提示选择。",
  steerSelected: "已选择 1. steer：正在中断当前任务并切换到新消息。",
  stackSelected: (queue) => `已选择 2. stack：新消息已进入队列。\n当前队列（按顺序）：\n${queue}`,
  stackQueueHeader: "当前队列（按顺序）：",

  sessionOptionExpired: "这个会话选项已过期，请重新执行 /sessions。",
  sessionOptionWrongConversation: "这个会话选项不属于当前对话，请重新执行 /sessions。",
  sessionSelectionInvalid: "会话选择无效，请重新执行 /sessions。",
  sessionSelected: (name) => `已选择会话：${name}`,
  sessionSendNewName: "请直接发送新的 session 名称。",
  sessionSendCancel: "发送 /cancel 可取消。",

  renameOptionExpired: "这个重命名选项已过期，请重新执行 /rename。",
  renameOptionWrongConversation: "这个重命名选项不属于当前对话，请重新执行 /rename。",
  renameNameEmpty: "名称不能为空，请重新发送新的 session 名称。",
  renameNameInvalid: "名称无效，请重新发送新的 session 名称。",
  renameTargetMissing: "目标 session 不存在，请重新执行 /rename。",
  renameSuccess: (_oldName, newName) => `session 已重命名为：${newName}`,

  projectOptionExpired: "这个项目选项已过期，请重新执行 /project。",
  projectOptionWrongConversation: "这个项目选项不属于当前对话，请重新执行 /project。",
  projectSelectionInvalid: "项目选择无效，请重新执行 /project。",
  projectSwitched: (name) => `已切换 project：${name}\n后续新对话将绑定到该 project。`,
  projectSendNewName: "请直接发送新 project 名称。",
  projectSendCancel: "发送 /cancel 可取消。",
  projectNameEmpty: "project 名称不能为空，请重新发送。",
  projectNameInvalid: "project 名称无效，不能包含 / 或 \\，且不能是 . 或 ..",
  projectNameTraversal: "project 名称无效，请更换名称后重试。",
  projectAlreadyExists: (name) => `project 已存在：${name}，请换一个名称。`,
  projectCreateFailed: (error) => `新建 project 失败：${error}`,
  projectCreated: (name) => `已新建并切换 project：${name}\n后续新对话将绑定到该 project。`,
  projectRootNotConfigured:
    "未配置 project root，请先执行 `opencarapace config tui` 设置 runtime.project_root_dir。",
  noRenamableSessions: "当前 project 暂无可重命名会话，请先发送消息创建会话。",

  prevPage: "◀ 上一页",
  nextPage: "下一页 ▶",
  morePage: "更多 ▶",
  createProject: "➕ 新建 project",
  currentProject: (name) => `当前 project：${name}`,
  sessionPickerHeader: (project) =>
    `当前 project：${project}\n点击会话可查看该会话名称和最近 20 条 history：`,
  renamePickerHeader: "点击会话后发送新名称：",
  sandboxPickerHeader: "点击按钮直接切换：",
  modelPickerHeader: "点击按钮设置模型：",
  depthPickerHeader: "点击按钮设置深度：",
  projectPickerHeader: (current, hasProjects) =>
    hasProjects
      ? `当前 project：${current}\n点击项目可切换，列表按最近使用时间排序；底部按钮可新建项目。`
      : `当前还没有可选项目，点击底部按钮新建。\n当前 project：${current}`,

  positiveIntegerRequired: "请输入正整数（>= 1），留空可保留当前值。",
  inputCancelled: "已取消当前输入操作。",
};

const EN: Messages = {
  taskError: (error) => `Task error: ${error}`,
  noReadableResult: "No readable result. Please try again.",
  fullResponseCaption: "Full response (text attachment)",
  processing: (preview) => `Processing: ${preview}`,

  locatedRunningMessage: "Located the current running message.",
  taskFailed: (reason) => `Task failed: ${reason}`,

  turnDecisionHeading: "New message detected",
  turnDecisionBody: "A task is still running. Choose how to proceed:",
  turnDecisionSteer: "1. steer: interrupt the current task and switch to the new message",
  turnDecisionStack: "2. stack: keep the current task and queue the new message",
  turnDecisionHeadingHtml: "<b>New message detected</b>",
  turnDecisionSteerHtml: "1. <b>steer</b>: interrupt the current task and switch to the new message",
  turnDecisionStackHtml: "2. <b>stack</b>: keep the current task and queue the new message",

  noPendingDecision: "No pending message to decide on. Send a new message directly.",
  decisionExpired: "This option has expired. Please use the latest prompt.",
  steerSelected: "Selected 1. steer: interrupting the current task and switching to the new message.",
  stackSelected: (queue) => `Selected 2. stack: new message added to queue.\nCurrent queue (in order):\n${queue}`,
  stackQueueHeader: "Current queue (in order):",

  sessionOptionExpired: "This session option has expired. Please run /sessions again.",
  sessionOptionWrongConversation:
    "This session option does not belong to the current conversation. Please run /sessions again.",
  sessionSelectionInvalid: "Invalid session selection. Please run /sessions again.",
  sessionSelected: (name) => `Selected session: ${name}`,
  sessionSendNewName: "Send the new session name directly.",
  sessionSendCancel: "Send /cancel to cancel.",

  renameOptionExpired: "This rename option has expired. Please run /rename again.",
  renameOptionWrongConversation:
    "This rename option does not belong to the current conversation. Please run /rename again.",
  renameNameEmpty: "Name cannot be empty. Please send a new session name.",
  renameNameInvalid: "Invalid name. Please send a new session name.",
  renameTargetMissing: "Target session not found. Please run /rename again.",
  renameSuccess: (_oldName, newName) => `Session renamed to: ${newName}`,

  projectOptionExpired: "This project option has expired. Please run /project again.",
  projectOptionWrongConversation:
    "This project option does not belong to the current conversation. Please run /project again.",
  projectSelectionInvalid: "Invalid project selection. Please run /project again.",
  projectSwitched: (name) => `Switched to project: ${name}\nFuture conversations will be bound to this project.`,
  projectSendNewName: "Send the new project name directly.",
  projectSendCancel: "Send /cancel to cancel.",
  projectNameEmpty: "Project name cannot be empty. Please send a name.",
  projectNameInvalid: "Invalid project name. It cannot contain / or \\, and cannot be . or ..",
  projectNameTraversal: "Invalid project name. Please try a different name.",
  projectAlreadyExists: (name) => `Project already exists: ${name}. Please choose a different name.`,
  projectCreateFailed: (error) => `Failed to create project: ${error}`,
  projectCreated: (name) => `Created and switched to project: ${name}\nFuture conversations will be bound to this project.`,
  projectRootNotConfigured:
    "Project root not configured. Please run `opencarapace config tui` and set runtime.project_root_dir.",
  noRenamableSessions: "No renamable sessions in the current project. Send a message first to create a session.",

  prevPage: "◀ Prev",
  nextPage: "Next ▶",
  morePage: "More ▶",
  createProject: "➕ New project",
  currentProject: (name) => `Current project: ${name}`,
  sessionPickerHeader: (project) =>
    `Current project: ${project}\nClick a session to view its name and the last 20 history entries:`,
  renamePickerHeader: "Click a session, then send the new name:",
  sandboxPickerHeader: "Click a button to switch:",
  modelPickerHeader: "Click a button to set the model:",
  depthPickerHeader: "Click a button to set the depth:",
  projectPickerHeader: (current, hasProjects) =>
    hasProjects
      ? `Current project: ${current}\nClick a project to switch. List is sorted by most recent use. Use the bottom button to create a new project.`
      : `No projects available yet. Use the bottom button to create one.\nCurrent project: ${current}`,

  positiveIntegerRequired: "Please enter a positive integer (>= 1). Leave blank to keep the current value.",
  inputCancelled: "Current input operation cancelled.",
};

const MESSAGES: Record<Locale, Messages> = { zh: ZH, en: EN };

export function getMessages(locale: Locale): Messages {
  return MESSAGES[locale];
}
