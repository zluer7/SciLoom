import type { Language } from "./translations";

type UiDictionary = Record<string, string>;

const englishUi: UiDictionary = {
  "文稿切换需要恢复处理。": "The manuscript switch needs recovery.",
  "当前稿已切换，但显示信息尚未更新完成。": "The current manuscript has switched, but its displayed information has not finished updating.",
  "文稿状态已变化，请重新加载后确认切换。": "The manuscript state has changed. Reload before confirming the switch.",
  "文稿状态已变化，切换未完成。": "The manuscript state has changed; the switch did not complete.",
  "文稿会话已不可用，请重新打开当前稿和目标稿。": "The manuscript session is unavailable. Reopen the current and target manuscripts.",
  "文稿会话已不可用，切换未完成。": "The manuscript session is unavailable; the switch did not complete.",
  "另一项文稿操作仍在进行，请等待完成。": "Another manuscript operation is in progress. Wait for it to finish.",
  "另一项文稿操作仍在进行，切换未完成。": "Another manuscript operation is in progress; the switch did not complete.",
  "文稿存在冲突或未保存修改，请先处理当前文稿状态。": "The manuscript has a conflict or unsaved changes. Resolve its current state first.",
  "文稿切换未完成。": "The manuscript switch did not complete.",
  "文稿工作区": "Manuscript workspace",
  "文稿工作区尚未建立": "Manuscript workspace is not established",
  "路径配置无法创建文稿工作区": "The path configuration cannot create the manuscript workspace",
  "正在重试建档": "Retrying workspace provisioning",
  "文稿工作区已建立": "Manuscript workspace established",
  "文稿工作区待恢复": "Manuscript workspace requires recovery",
  "重试建档": "Retry provisioning",
  "当前路径状态不可重试": "The current path state is not retryable",
  "当前文稿根目录与课题目录组合超过安全路径预算。请调整正式文稿根目录或课题命名策略。": "The manuscript root and Project directory exceed the safe path budget. Adjust the formal manuscript root or Project naming policy.",
  "文稿工作区仍未完成，请查看错误分类后重试。": "The manuscript workspace is still incomplete. Review the error category before retrying.",
  "阶段": "Phase",
  "错误分类": "Error category",
  "原因": "Cause",
  "已完成步骤": "Completed steps",
  "元数据类型": "Metadata kind",
  "未填写": "Not filled",
  "确认将“{filename}”设为当前{owner}。默认稿保持不变，文稿正文内容保留，文件不会移动、改名或删除；结构化纲要仅按当前文稿切换规则更新。": "Set “{filename}” as the current{owner}. The default manuscript remains unchanged, manuscript body content is preserved, and no file is moved, renamed, or deleted; the structured outline is updated only under the current manuscript-switch rules.",
  "结构化纲要可导入字段（{importedCount}）：{importedLabels}；缺失字段（{missingCount}）：{missingLabels}。缺失字段按空值处理，不继承原稿。": "Structured outline importable fields ({importedCount}): {importedLabels}; missing fields ({missingCount}): {missingLabels}. Missing fields are cleared and do not inherit values from the previous manuscript.",
  " 内容提示：{notices}（不阻断切换）。": " Content note: {notices} (does not block switching).",
  "实验文稿": "Experiment manuscript",
  "Run 文稿": "Run manuscript",
  "课题专属笔记": "Project-specific notes",
  "复盘文稿": "Review manuscript",
  "成果文稿": "Output manuscript",
  "结果资产文稿": "Result asset manuscript",
  "关键发现文稿": "Finding manuscript",
  "候选成果文稿": "Output candidate manuscript",
  "成果缺口文稿": "Output gap manuscript",
  "正式成果文稿": "Research output manuscript",
  "此区域作为文稿切换的可读区域，请勿修改格式。": "This area is read during manuscript switching. Do not modify its formatting.",
  "是": "Yes",
  "否": "No",
  "未设置": "Not set",
  "未评级": "Not rated",
  "无说明": "No description",
  "暂无描述": "No description",
  "暂无摘要": "No summary",
  "未关联": "Not linked",
  "未关联课题": "No project",
  "关联课题不存在或已删除": "The linked project no longer exists or has been deleted",
  "关联课题暂时无法加载": "The linked project is temporarily unavailable",
  "关联课题不存在或已删除。基础详情、编辑和删除仍可使用；依赖课题或文稿的功能暂不可用。": "The linked project no longer exists or has been deleted. Basic details, metadata editing, and deletion remain available; project- or manuscript-dependent features are temporarily unavailable.",
  "关联课题暂时无法加载。基础详情、编辑和删除仍可使用。": "The linked project is temporarily unavailable. Basic details, metadata editing, and deletion remain available.",
  "文稿文件缺失。基础详情、编辑和删除仍可使用，文稿功能需要单独恢复。": "Manuscript files are missing. Basic details, metadata editing, and deletion remain available; manuscript features require separate recovery.",
  "部分详情暂时无法加载。基础详情、编辑和删除仍可使用。": "Some details are temporarily unavailable. Basic details, metadata editing, and deletion remain available.",
  "路径详情暂时无法加载；基础文献详情和删除仍可使用。": "Path details are temporarily unavailable; basic literature details and deletion remain available.",
  "实验管理": "Experiment management",
  "基于统一 selector / export 层管理研究活动、运行记录、指标和文件路径索引。": "Manage research activities, runs, metrics, and file-path indexes through the unified selector and export layer.",
  "关键词": "Keywords",
  "名称、目的、方法、结果、结论": "Title, purpose, method, result, or conclusion",
  "课题": "Project",
  "全部课题": "All projects",
  "状态": "Status",
  "全部状态": "All statuses",
  "标签": "Tags",
  "逗号分隔，任一匹配": "Comma-separated; match any",
  "逗号分隔": "Comma-separated",
  "逗号或分号分隔": "Comma- or semicolon-separated",
  "用逗号分隔": "Comma-separated",
  "新建实验": "Create experiment",
  "实验列表": "Experiments",
  "暂无符合条件的实验记录。": "No experiments match the current filters.",
  "正在加载实验记录。": "Loading experiment records.",
  "实验列表加载失败，请稍后重试。": "Experiment records could not be loaded. Try again later.",
  "当前课题下暂无实验。": "No experiments under the current project.",
  "当前筛选下暂无实验。": "No experiments match the current filters.",
  "请选择有效课题。": "Select a valid project.",
  "请选择有效路线。": "Select a valid route.",
  "关联路线必须属于当前课题。": "The linked route must belong to the current project.",
  "请选择有效任务。": "Select a valid task.",
  "关联任务必须属于当前课题。": "The linked task must belong to the current project.",
  "关联任务与关联路线不一致。": "The linked task does not match the linked route.",
  "请等待实验详情加载完成后再保存 Run。": "Wait for experiment details to finish loading before saving the run.",
  "已定位到指定 Run。": "Focused the requested run.",
  "未找到 query 指定的 Run。": "The run from the query was not found.",
  "已定位到指定实验。": "Focused the requested experiment.",
  "未找到 query 指定的实验。": "The experiment from the query was not found.",
  "已定位到关联任务的实验。": "Focused an experiment linked to the requested task.",
  "该任务暂无关联实验。": "This task has no linked experiments yet.",
  "未找到 query 指定的任务。": "The task from the query was not found.",
  "已定位到指定课题。": "Focused the requested project.",
  "未找到 query 指定的课题。": "The project from the query was not found.",
  "编辑实验": "Edit experiment",
  "实验基础信息": "Experiment basic info",
  "所属课题": "Project",
  "请选择课题": "Select a project",
  "关联路线": "Linked route",
  "不关联路线": "No linked route",
  "关联任务": "Linked task",
  "不关联任务": "No linked task",
  "实验名称": "Experiment title",
  "实验简介": "Experiment intro",
  "实验摘要": "Experiment summary",
  "实验危险操作": "Experiment danger zone",
  "AI分析": "AI Analysis",
  "打开编辑器": "Open Editor",
  "关闭操作结果": "Dismiss action result",
  "已取消打开文稿，当前稿和默认稿未改变。": "Opening was canceled. The current and default manuscripts are unchanged.",
  "已取消切换文稿，当前稿和默认稿未改变。": "Switching was canceled. The current and default manuscripts are unchanged.",
  "已取消登记外部文稿，未产生任何更改。": "External manuscript registration was canceled. No changes were made.",
  "已取消登记外部文稿，当前稿和默认稿未改变。": "External manuscript registration was canceled. The current and default manuscripts are unchanged.",
  "所选文件已是当前文稿。": "The selected file is already the current manuscript.",
  "所选文件不是有效的 Experiment 文稿，未执行打开或切换。": "The selected file is not a valid Experiment manuscript. It was not opened or switched.",
  "实验文稿选择失败，未执行打开。": "The Experiment manuscript could not be selected and was not opened.",
  "实验文稿选择失败，未执行切换。": "The Experiment manuscript could not be selected and was not switched.",
  "所选 Experiment 文稿无法读取，未打开独立窗口。": "The selected Experiment manuscript could not be read, so no independent window was opened.",
  "所选文稿已登记，但无法按 Experiment 文稿格式读取；当前稿和默认稿未改变。": "The selected manuscript was registered but could not be read as an Experiment manuscript. The current and default manuscripts are unchanged.",
  "所选文稿已在独立窗口打开；当前稿和默认稿未改变。": "The selected manuscript opened in an independent window. The current and default manuscripts are unchanged.",
  "目标文稿登记失败，当前稿未改变。": "The target manuscript could not be registered. The current manuscript is unchanged.",
  "切换文稿预检失败，当前稿未改变。": "The manuscript switch preflight failed. The current manuscript is unchanged.",
  "实验文稿切换失败，当前稿未改变。": "The Experiment manuscript switch failed. The current manuscript is unchanged.",
  "当前实验文稿已切换；默认稿保持不变。": "The current Experiment manuscript was switched. The default manuscript is unchanged.",
  "无法选择所需的 Markdown 文稿。": "The requested Markdown manuscript could not be selected.",
  "实验文稿工作区无法安全使用。": "The Experiment manuscript workspace cannot be used safely.",
  "无法读取所选 Markdown 文稿。": "The selected Markdown manuscript could not be read.",
  "无法查询所选文稿的登记信息。": "The selected manuscript registration could not be queried.",
  "实验文稿登记失败。": "The Experiment manuscript registration failed.",
  "实验文稿身份校验失败。": "The Experiment manuscript identity validation failed.",
  "实验文稿会话迁移失败。": "The Experiment manuscript session migration failed.",
  "实验文稿会话无法激活。": "The Experiment manuscript session could not be activated.",
  "实验文稿切换预检失败。": "The Experiment manuscript switch preflight failed.",
  "错误码": "Error code",
  "原因码": "Cause code",
  "操作号": "Operation ID",
  "恢复建议": "Recovery",
  "研究目的": "Research purpose",
  "研究问题": "Research question",
  "实验目的与问题": "Experiment purpose and question",
  "假设": "Hypothesis",
  "评级": "Rating",
  "条件摘要": "Condition summary",
  "运行条件摘要": "Run condition summary",
  "变量与参数摘要": "Variable and parameter summary",
  "方法摘要": "Method summary",
  "运行方法摘要": "Run method summary",
  "结果摘要": "Result summary",
  "运行结果摘要": "Run result summary",
  "结论": "Conclusion",
  "结论说明": "Conclusion notes",
  "结论与下一步": "Conclusion and next step",
  "阶段摘要": "Stage summary",
  "关键进展": "Key progress",
  "已完成内容": "Completed items",
  "主要问题": "Major problems",
  "原因分析": "Cause analysis",
  "下一步计划": "Next-step plan",
  "周期摘要": "Period summary",
  "本周期完成": "Completed this period",
  "本周期未完成 / 延期": "Incomplete or delayed this period",
  "下周期计划": "Next-period plan",
  "对比摘要": "Comparison summary",
  "对比对象": "Comparison targets",
  "关键差异": "Key differences",
  "异常与问题": "Anomalies and problems",
  "下一步实验计划": "Next experiment plan",
  "综述摘要": "Literature overview",
  "对比文献范围": "Literature comparison scope",
  "方法差异": "Method differences",
  "结论共识与分歧": "Consensus and divergence",
  "研究空白 / 可借鉴点": "Research gaps and reusable insights",
  "后续阅读或研究计划": "Further reading or research plan",
  "关键指标或现象": "Key metric or phenomenon",
  "实验条件简述": "Experiment condition summary",
  "初步判断": "Initial assessment",
  "可转化价值": "Conversion value",
  "发现内容": "Finding",
  "支撑证据": "Supporting evidence",
  "新颖性或差异": "Novelty or difference",
  "可靠性判断": "Reliability assessment",
  "边界或缺失证据": "Boundaries or missing evidence",
  "核心主张": "Core claim",
  "成果类型": "Output type",
  "创新贡献": "Innovation contribution",
  "证据摘要": "Evidence summary",
  "风险与缺口": "Risks and gaps",
  "缺口说明": "Gap description",
  "缺口类型": "Gap type",
  "影响对象": "Affected object",
  "补强计划": "Strengthening plan",
  "完成标准": "Completion criteria",
  "成果摘要": "Output summary",
  "核心贡献": "Core contribution",
  "来源链摘要": "Source-chain summary",
  "归档用途": "Archive use",
  "自由记录": "Free-form notes",
  "自由记录（不强制填写）": "Free-form notes (optional)",
  "插入记录模板": "Insert note template",
  "用于记录过程、异常、补充说明。": "Use for process notes, issues, and supplementary details.",
  "记录模板已插入。": "Note template inserted.",
  "文件路径索引": "File-path index",
  "只保存路径，不保存大文件本体": "Store the path only, not the large file",
  "可用于论文": "Usable for paper",
  "可用于汇报": "Usable for report",
  "可用于专利": "Usable for patent",
  "保存实验": "Save experiment",
  "创建实验": "Create experiment",
  "清空": "Reset",
  "数据清除": "Data clearing",
  "实验详情": "Experiment details",
  "路线": "Route",
  "任务": "Task",
  "条件": "Conditions",
  "方法": "Method",
  "结果": "Result",
  "论文": "Paper",
  "汇报": "Report",
  "专利": "Patent",
  "Run 列表": "Runs",
  "未填写结果": "No result provided",
  "暂无运行记录。": "No runs yet.",
  "新建 Run": "Create run",
  "编辑 Run": "Edit run",
  "Run 名称": "Run title",
  "编号": "Run label",
  "保存 Run": "Save run",
  "创建 Run": "Create run",
  "Run 详情": "Run details",
  "Run 基础信息": "Run basic info",
  "Run 简介": "Run intro",
  "Run 摘要": "Run summary",
  "Run 危险操作": "Run danger zone",
  "所属实验": "Experiment",
  "所属任务": "Task",
  "请选择或创建 Run。": "Select or create a run.",
  "编辑指标": "Edit metric",
  "新增指标": "Add metric",
  "指标名称": "Metric name",
  "指标值": "Metric value",
  "单位": "Unit",
  "类型": "Type",
  "说明": "Description",
  "保存指标": "Save metric",
  "当前 Run 指标": "Current run metrics",
  "编辑": "Edit",
  "删除": "Delete",
  "暂无指标。": "No metrics yet.",
  "编辑文件路径": "Edit file path",
  "新增文件路径": "Add file path",
  "归属": "Owner",
  "实验": "Experiment",
  "当前 Run": "Current run",
  "标题": "Title",
  "路径": "Path",
  "只保存路径索引": "Store the path index only",
  "保存路径": "Save path",
  "新增路径": "Add path",
  "文件路径引用": "File references",
  "暂无文件路径引用。": "No file references yet.",
  "路径记录": "Path Records",
  "添加路径记录": "Add Path Record",
  "编辑路径记录": "Edit Path Record",
  "保存路径记录": "Save Path Record",
  "路径记录已新增。": "Path record added.",
  "路径记录已更新。": "Path record updated.",
  "路径记录已移入回收站。": "Path record moved to recycle bin.",
  "请先选择文献，并填写路径和文件类型。": "Select a literature item, then enter a path and file type.",
  "请先选择文献，并填写路径。": "Select a literature item, then enter a path.",
  "PDF": "PDF",
  "补充材料": "Supplement",
  "外部阅读笔记": "External reading note",
  "截图 / 图片": "Screenshot / image",
  "代码或数据引用": "Code or data reference",
  "只保存路径和元数据，不会读取或上传文件正文。": "Only path metadata is stored; file contents are not read or uploaded.",
  "暂无路径记录": "No path records yet.",
  "打开第一条路径记录": "Open the first path record",
  "尚未添加路径记录，请先添加文件或文件夹路径。": "No path record yet. Add a file or folder path first.",
  "当前路径记录没有有效路径。": "The current path record has no valid path.",
  "打开失败，请检查路径是否存在。": "Failed to open. Check whether the path exists.",
  "路径已选择。": "Path selected.",
  "路径已打开。": "Path opened.",
  "文件已打开。": "File opened.",
  "文件夹已打开。": "Folder opened.",
  "已打开所在文件夹。": "Containing folder opened.",
  "路径操作已完成。": "Path action completed.",
  "路径操作失败。": "Path action failed.",
  "文献路径记录将移入回收站，并从当前文献详情中隐藏。": "The literature path record will move to recycle bin and disappear from the current detail view.",
  "所属文献": "Literature owner",
  "文献本体不会被删除。": "The literature record itself will not be deleted.",
  "删除后该路径记录不再出现在文献详情。": "After deletion, this path record will no longer appear in literature details.",
  "不会删除文献本体。": "The literature record will not be deleted.",
  "不会删除本地真实文件。": "The real local file will not be deleted.",
  "不会读取或上传文件正文。": "File contents will not be read or uploaded.",
  "可从回收站恢复路径记录元数据。": "Path-record metadata can be restored from recycle bin.",
  "DOI / URL 仍保留为文献元数据，不会自动迁移。": "DOI / URL remain literature metadata and are not automatically migrated.",
  "文件类型": "File Type",
  "数据文件夹": "Data folder",
  "图片": "Image",
  "报告": "Report",
  "代码": "Code",
  "脚本": "Script",
  "其他附件": "Attachment",
  "其他": "Other",
  "路径摘要": "Path Summary",
  "工作目录": "Workspace",
  "备注": "Notes",
  "只记录路径和备注，不读取文件内容": "Only the path and notes are recorded; file contents are not read",
  "不会复制、移动、删除或上传本地文件": "Local files are not copied, moved, deleted, or uploaded",
  "完整路径不会默认展示": "The full path is hidden by default",
  "可选；留空时使用路径尾部名称": "Optional; the trailing path name is used when empty",
  "手动输入文件或文件夹路径": "Enter a file or folder path manually",
  "选择文件": "Choose File",
  "选择文件夹": "Choose Folder",
  "打开": "Open",
  "打开文件": "Open file",
  "打开文件夹": "Open Folder",
  "打开所在文件夹": "Open Folder",
  "复制路径": "Copy Path",
  "复制文件夹路径": "Copy Folder Path",
  "路径已复制": "Path copied",
  "用户已取消选择": "Selection canceled",
  "当前环境不支持本地文件操作": "Local file operations are not supported in this environment",
  "无法选择文件路径": "Unable to select a file path",
  "无法打开文件": "Unable to open file",
  "无法打开路径": "Unable to open path",
  "无法打开所在文件夹": "Unable to reveal in folder",
  "无法复制路径": "Unable to copy path",
  "请填写路径并选择文件类型。": "Enter a path and select a file type.",
  "请填写路径。": "Enter a path.",
  "请先选择有效的实验或 Run。": "Select a valid experiment or run first.",
  "路径记录保存失败。": "The path record could not be saved.",
  "Markdown 预览": "Markdown preview",
  "复制": "Copy",
  "成果 / AI 上下文预览": "Output / AI context preview",
  "该入口仅展示结构化上下文，不接入 AI，也不生成外部文件。": "This view only shows structured context. It does not call AI or generate external files.",
  "Run 数量": "Run count",
  "指标数量": "Metric count",
  "结果指标": "Result metrics",
  "为当前 Run 记录结构化指标，并由用户确认关键结果与成果项提升。": "Record structured metrics for this run, with explicit confirmation for key results and ResultItem promotion.",
  "值类型": "Value type",
  "指标分组": "Metric group",
  "指标说明": "Metric description",
  "关键结果": "Key result",
  "指标名称不能为空。": "Metric name is required.",
  "请输入有效的数值。": "Enter a valid numeric value.",
  "指标保存失败。": "The metric could not be saved.",
  "指标已添加。": "Metric added.",
  "标记为关键结果": "Mark as key result",
  "取消关键结果": "Unmark key result",
  "已标记为关键结果。": "Marked as a key result.",
  "已取消关键结果标记。": "Key-result mark removed.",
  "关键结果状态更新失败。": "The key-result status could not be updated.",
  "提升为 ResultItem": "Promote to ResultItem",
  "已提升": "Promoted",
  "查看已提升状态": "View promotion status",
  "该指标已提升为 ResultItem：": "This metric has already been promoted to a ResultItem: ",
  "指标已提升为 ResultItem。": "Metric promoted to a ResultItem.",
  "该指标已提升，无需重复创建。": "This metric is already promoted; no duplicate was created.",
  "提升为 ResultItem 失败。": "Promotion to ResultItem failed.",
  "确认提升为 ResultItem": "Confirm promotion to ResultItem",
  "将从当前指标创建或关联一个 ResultItem，供成果转化链路使用。": "A ResultItem will be created or linked from this metric for use in the output-conversion workflow.",
  "原 ResultMetric 不会被删除。": "The original ResultMetric will not be deleted.",
  "后续修改 ResultMetric 不会自动同步 ResultItem。": "Later ResultMetric changes will not automatically update the ResultItem.",
  "若该指标已经提升，将复用现有关联，不会重复创建。": "If this metric is already promoted, the existing link will be reused and no duplicate will be created.",
  "确认提升": "Confirm promotion",
  "正在提升…": "Promoting...",
  "该指标已提升为 ResultItem；修改指标不会自动同步成果项。": "This metric has been promoted to a ResultItem; editing it will not automatically update the output item.",
  "当前 Run 暂无结果指标。": "This run has no result metrics yet.",
  "请先选择 Run。": "Select a run first.",
  "删除实验": "Delete experiment",
  "删除 Run": "Delete run",
  "删除指标": "Delete metric",
  "删除路径记录": "Delete Path Record",
  "移入回收区": "Move to recycle area",
  "删除操作已取消。": "Delete operation cancelled.",
  "删除已完成，但操作日志或回收记录写入失败：": "Deletion completed, but the operation log or recycle entry could not be recorded: ",
  "该实验将被移入回收区，并从默认实验列表中隐藏。": "This experiment will be moved to the recycle area and hidden from the default experiment list.",
  "关联 Run": "Linked runs",
  "Run 元数据不会级联删除，但将不再从该实验详情进入。": "Run metadata will not be cascade-deleted, but it will no longer be accessible from this experiment detail.",
  "关联指标": "Linked metrics",
  "指标和已提升 ResultItem 不会自动删除。": "Metrics and promoted ResultItems will not be automatically deleted.",
  "文件引用": "File references",
  "文件引用元数据不会级联删除，磁盘真实文件不会被删除。": "File-reference metadata will not be cascade-deleted, and real files on disk will not be deleted.",
  "不会永久删除 SciLoom 元数据。": "SciLoom metadata will not be permanently deleted.",
  "不会删除已提升 ResultItem、Finding 或 OutputCandidate。": "Promoted ResultItems, Findings, and OutputCandidates will not be deleted.",
  "不会删除或读取路径指向的本地文件。": "Local files referenced by paths will not be deleted or read.",
  "该 Run 将被移入回收区，并从当前实验详情中隐藏。": "This run will be moved to the recycle area and hidden from the current experiment detail.",
  "Run 下指标": "Metrics under this run",
  "指标元数据不会级联删除，但将不再从该 Run 详情显示。": "Metric metadata will not be cascade-deleted, but it will no longer appear in this run detail.",
  "Run 下文件引用": "File references under this run",
  "已提升 ResultItem": "Promoted ResultItems",
  "已提升成果项不会自动删除或覆盖。": "Promoted output items will not be automatically deleted or overwritten.",
  "不会删除 Experiment 或已提升成果项。": "The Experiment and promoted output items will not be deleted.",
  "该指标将被移入回收区，并从当前 Run 指标列表中隐藏。": "This metric will be moved to the recycle area and hidden from the current run metric list.",
  "关联 ResultItem 保留，不会自动删除或同步。": "The linked ResultItem will be retained and will not be automatically deleted or synchronized.",
  "不会删除 EntityLink、Finding 或 OutputCandidate。": "EntityLinks, Findings, and OutputCandidates will not be deleted.",
  "不会触发 AI 或成果转化重算。": "No AI call or output-conversion recalculation will be triggered.",
  "仅将 SciLoom 中的文件引用记录移入回收区。": "Only the SciLoom file-reference record will be moved to the recycle area.",
  "所属实验记录将失去该路径引用": "The owning experiment record will lose this path reference",
  "不会删除或移动磁盘上的真实文件。": "Real files on disk will not be deleted or moved.",
  "不会读取文件内容，也不会上传文件。": "File content will not be read or uploaded.",
  "实验已移入回收区。": "Experiment moved to the recycle area.",
  "实验不存在或已被删除。": "The experiment does not exist or has already been deleted.",
  "Run 已移入回收区。": "Run moved to the recycle area.",
  "Run 不存在或已被删除。": "The run does not exist or has already been deleted.",
  "指标已移入回收区。": "Metric moved to the recycle area.",
  "指标不存在或已被删除。": "The metric does not exist or has already been deleted.",
  "文件引用已移入回收区，磁盘文件未被删除。": "File reference moved to the recycle area; the disk file was not deleted.",
  "文件引用不存在或已被删除。": "The file reference does not exist or has already been deleted.",
  "文件路径数量": "File-path count",
  "关键发现": "Key findings",
  "请先选择课题并填写实验名称。": "Select a project and enter an experiment title.",
  "实验已更新。": "Experiment updated.",
  "实验已创建。": "Experiment created.",
  "请先选择实验并填写 Run 名称。": "Select an experiment and enter a run title.",
  "运行记录已更新。": "Run updated.",
  "运行记录已创建。": "Run created.",
  "请先选择 Run，并填写指标名称和值。": "Select a run and enter the metric name and value.",
  "指标已更新。": "Metric updated.",
  "指标已新增。": "Metric added.",
  "请先选择归属对象，并填写文件路径。": "Select an owner and enter a file path.",
  "文件路径已更新。": "File path updated.",
  "文件路径已新增。": "File path added.",
  "确认删除该指标记录？": "Delete this metric?",
  "指标已删除。": "Metric deleted.",
  "确认删除该文件路径引用？": "Delete this file reference?",
  "文件路径引用已删除。": "File reference deleted.",
  "Markdown 已复制到剪贴板。": "Markdown copied to the clipboard."
  ,"打开 Markdown 编辑器": "Open Markdown editor"
  ,"实验记录 / Markdown 编辑": "Experiment notes / Markdown editor"
  ,"运行记录 / Markdown 编辑": "Run notes / Markdown editor"
  ,"Markdown 编辑 / 实验记录": "Markdown Editor / Experiment Record"
  ,"Markdown 编辑 / 实验 Run 记录": "Markdown Editor / Experiment Run Record"
  ,"Markdown 编辑器 / 文献纲要": "Markdown Editor / Literature Outline"
  ,"Markdown 编辑器 / 专属笔记": "Markdown Editor / Project-specific Notes"
  ,"Markdown 编辑": "Markdown Editor"
  ,"专属笔记": "Dedicated Notes"
  ,"独立编辑": "Independent Editing"
  ,"专属笔记（独立编辑）": "Dedicated Notes (Independent Editing)"
  ,"实验记录": "Experiment Record"
  ,"实验 Run 记录": "Experiment Run Record"
  ,"文献记录": "Literature Record"
  ,"复盘记录": "Review Record"
  ,"成果记录": "Output Record"
  ,"自定义记录": "Custom Record"
  ,"结构化摘要": "Structured Summary"
  ,"原文": "Original"
  ,"预览": "Preview"
  ,"插入模板": "Insert Template"
  ,"编辑与预览": "Edit and preview"
  ,"正在生成预览…": "Generating preview..."
  ,"插入上下文结构": "Insert Context Structure"
  ,"此窗口不适用模板插入。": "Template insertion is not applicable to this window."
  ,"已插入，尚未保存。": "Inserted into the draft; not saved yet."
  ,"插入内容包含保留的 Archive 控制行，未修改草稿。": "The inserted content contains reserved Archive control lines. The draft was not changed."
  ,"当前文稿无法完成插入，草稿未修改。": "The insertion could not be completed in the current manuscript. The draft was not changed."
  ,"上下文结构当前不可用，草稿未修改。": "The context structure is unavailable. The draft was not changed."
  ,"无法生成当前草稿预览；未执行保存或写入。": "The current draft preview could not be generated. No save or write was performed."
  ,"无法生成当前文稿预览，文稿内容未受影响。": "The manuscript preview could not be generated. The manuscript content was not affected."
  ,"另存为未启动：无法冻结当前分段草稿。": "Save As did not start because the current segmented draft could not be frozen."
  ,"当前上下文结构不可用": "The current context structure is unavailable"
  ,"选择要插入的模板": "Select a template to insert"
  ,"当前范围没有可用模板。": "No templates are available for this scope."
  ,"选择插入位置": "Select an insertion target"
  ,"当前有多个合法位置，请明确选择。": "Several valid targets are available. Select one explicitly."
  ,"文稿已变化，请重新执行插入。": "The manuscript changed. Start the insertion again."
  ,"结构段": "Structured section"
  ,"文稿正文": "Manuscript body"
  ,"自由正文": "Free manuscript body"
  ,"在此添加正文": "Add body text here"
  ,"文稿控制信息受保护，不会进入编辑区。": "Manuscript control information is protected and is not shown in editable regions."
  ,"文稿投影不可用；权威草稿已保留。": "The manuscript projection is unavailable; the authoritative draft has been retained."
  ,"文稿尚无正文": "This manuscript has no body text yet"
  ,"使用“开始正文”在唯一合法位置创建第一段内容。": "Use Start Body to create the first content at the only valid position."
  ,"开始正文": "Start Body"
  ,"新增正文": "New body text"
  ,"此结构段当前为空；标题仅用于说明，不会写入文稿。": "This structured section is empty. Its explanatory heading is not written to the manuscript."
  ,"结构段正文": "Structured section body"
  ,"当前文稿没有可预览的正文。": "The current manuscript has no body text to preview."
  ,"当前分段草稿预览": "Current segmented draft preview"
  ,"此处是只读的结构化业务摘要，仅供参考；不会自动覆盖右侧文稿。": "This is a read-only structured business summary for reference. It does not automatically overwrite the manuscript on the right."
  ,"此处编辑文稿正文；普通保存不会自动同步左侧结构化字段。": "Edit the manuscript body here. Ordinary save does not automatically synchronize the structured fields on the left."
  ,"保存文稿": "Save Manuscript"
  ,"打开文稿": "Open Manuscript"
  ,"切换文稿": "Switch Manuscript"
  ,"重新加载": "Reload"
  ,"当前分段不可编辑；草稿未被覆盖。": "This segment cannot be edited. The draft was not overwritten."
  ,"当前文稿为只读，无法保存。": "The current manuscript is read-only and cannot be saved."
  ,"内容未变化": "No changes"
  ,"未命名记录": "Untitled record"
  ,"文稿保存失败。": "The manuscript could not be saved."
  ,"文稿编辑器": "Manuscript editor"
  ,"实验运行记录": "Experiment Run Record"
  ,"文献专属笔记": "Literature Dedicated Notes"
  ,"候选成果": "Output Candidate"
  ,"正式成果": "Formal Output"
  ,"（独立编辑）": " (Independent Editing)"
  ,"未命名": "Untitled"
  ,"未选择": "Not selected"
  ,"当前文稿：": "Current manuscript:"
  ,"原文与预览": "Original and Preview"
  ,"开始撰写文稿": "Start writing the manuscript"
  ,"文稿原文": "Manuscript original"
  ,"文稿投影视图不可用。": "The manuscript view is unavailable."
  ,"独立编辑不适用模板插入": "Template insertion is not applicable to independent editing."
  ,"独立编辑不适用上下文摘要": "Context summary insertion is not applicable to independent editing."
  ,"独立编辑不适用此操作": "This action is not applicable to independent editing."
  ,"此操作当前不可用": "This action is currently unavailable."
  ,"当前上下文摘要不可用": "The current context summary is unavailable."
  ,"此窗口不适用上下文摘要。": "Context summary insertion is not applicable to this window."
  ,"上下文摘要当前不可用，草稿未修改。": "The context summary is unavailable; the draft was not changed."
  ,"请先在原文中定位插入位置。": "Place the cursor in the original text before choosing a template."
  ,"文稿或插入位置已变化，请关闭模板面板并重新定位。": "The manuscript or insertion position changed. Close the template panel and choose the position again."
  ,"当前文稿暂时不可用，草稿未被覆盖。": "The current manuscript is temporarily unavailable; the draft was not overwritten."
  ,"正在加载文稿…": "Loading manuscript..."
  ,"当前文稿预览": "Current manuscript preview"
  ,"当前操作无法安全完成，草稿未修改。": "The operation could not be completed safely; the draft was not changed."
  ,"文稿会话已失效，请重新打开后再保存。": "The manuscript session is no longer valid. Reopen it before saving."
  ,"文稿投影视图不可用；未启用可编辑原文回退，未执行写入。": "The manuscript projection is unavailable. No editable Raw fallback was enabled and no write was performed."
  ,"文稿已在磁盘上发生变化；当前草稿已保留，未覆盖外部修改。": "The manuscript changed on disk. The current draft was retained and the external change was not overwritten."
  ,"文稿正在执行其他操作，请稍后重试。": "Another manuscript operation is active. Try again later."
  ,"已保存": "Saved"
  ,"正在加载分段文稿编辑器…": "Loading the segmented manuscript editor..."
  ,"填充摘要": "Fill Summary"
  ,"导入文件": "Import File"
  ,"另存为": "Save As"
  ,"文稿副本已保存。": "Manuscript copy saved."
  ,"当前实验文稿会话不可用于另存为。": "The current Experiment manuscript session cannot be saved as a copy."
  ,"请选择不同的保存位置；保存原文件请使用“保存文稿”。": "Choose a different save location. Use Save Manuscript to update the current file."
  ,"目标文件在确认后发生变化，请重新选择保存位置。": "The target changed after confirmation. Choose the save location again."
  ,"文稿副本保存失败，原文稿和编辑状态未改变。": "The manuscript copy could not be saved. The current manuscript and editor state were not changed."
  ,"目标 Markdown 文件已存在。确认后将原子覆盖该副本文件；当前文稿、默认稿和编辑状态不会改变。": "The target Markdown file already exists. Confirmation will atomically overwrite only that copy; the current manuscript, default manuscript, and editor state will not change."
  ,"保存记录": "Save Record"
  ,"当前实验的结构化摘要，仅用于只读参考。": "Structured summary of the current experiment for read-only reference."
  ,"当前 Run 的结构化摘要，仅用于只读参考。": "Structured summary of the current run for read-only reference."
  ,"保存 Markdown 记录": "Save Markdown notes"
  ,"关闭 Markdown 编辑器": "Close Markdown editor"
  ,"Markdown 纯文本预览": "Markdown plain-text preview"
  ,"上下文摘要": "Context summary"
  ,"有未保存更改": "Unsaved changes"
  ,"当前文稿有未保存更改": "The current manuscript has unsaved changes"
  ,"关闭前，请选择保存更改、放弃更改或取消关闭。": "Before closing, save the changes, discard them, or cancel closing."
  ,"切换前，请选择保存更改、放弃更改或取消操作。": "Before switching, save the changes, discard them, or cancel the action."
  ,"保存并关闭": "Save and close"
  ,"有未保存更改，确认放弃吗？": "You have unsaved changes. Discard them?"
  ,"放弃更改": "Discard changes"
  ,"继续编辑": "Continue editing"
  ,"正在保存…": "Saving..."
  ,"Markdown 记录已保存。": "Markdown notes saved."
  ,"Markdown 记录保存失败。": "Markdown notes could not be saved."
  ,"暂无可预览内容。": "Nothing to preview."
  ,"导入 Markdown 文件": "Import Markdown file"
  ,"确认读取 Markdown 文件": "Confirm Markdown file read"
  ,"将读取所选 Markdown 文件正文，并导入当前编辑器草稿。该内容不会自动保存，也不会发送给 AI。是否继续？": "This will read the selected Markdown file and import its content into the current editor draft. It will not be saved automatically or sent to AI. Continue?"
  ,"确认读取": "Read file"
  ,"替换当前内容": "Replace current content"
  ,"追加到当前内容": "Append to current content"
  ,"取消导入": "Cancel import"
  ,"正在读取 Markdown 文件…": "Reading Markdown file..."
  ,"Markdown 文件读取失败。": "The Markdown file could not be read."
  ,"请选择 .md 或 .markdown 文件。": "Select a .md or .markdown file."
  ,"Markdown 文件超过 1 MiB 大小限制。": "The Markdown file exceeds the 1 MiB limit."
  ,"Markdown 文件不是有效的 UTF-8 文本。": "The Markdown file is not valid UTF-8 text."
  ,"Markdown 文件导入仅支持桌面端。": "Markdown file import is available only in the desktop app."
  ,"Markdown 内容已导入当前草稿：": "Markdown content imported into the current draft:"
  ,"已选择文件": "Selected file"
  ,"另存为 Markdown 文件": "Save as Markdown file"
  ,"正在保存 Markdown 文件…": "Saving Markdown file..."
  ,"已保存 Markdown 文件：": "Markdown file saved:"
  ,"Markdown 文件保存失败。请检查路径和权限。": "The Markdown file could not be saved. Check the path and permissions."
  ,"确认覆盖 Markdown 文件": "Confirm Markdown overwrite"
  ,"目标 Markdown 文件已存在。继续保存将覆盖该文件。该内容不会发送给 AI。是否确认覆盖？": "The target Markdown file already exists. Continuing will overwrite it. The content will not be sent to AI. Overwrite?"
  ,"确认覆盖": "Overwrite file"
  ,"取消覆盖": "Cancel overwrite"
  ,"请选择 .md 或 .markdown 保存路径。": "Save to a .md or .markdown file."
  ,"Markdown 内容超过 1 MiB 大小限制。": "The Markdown content exceeds the 1 MiB limit."
  ,"所选保存目录不存在。": "The selected parent folder was not found."
  ,"Markdown 文件保存仅支持桌面端。": "Markdown file saving is available only in the desktop app."
  ,"图片引用": "Image reference"
  ,"文献": "Literature"
  ,"文献基础信息": "Literature Basic Information"
  ,"文献简介": "Literature Intro"
  ,"简介": "Introduction"
  ,"结构化纲要": "Structured outline"
  ,"正文": "Body"
  ,"只读": "Read only"
  ,"文献纲要已保存。": "Literature outline saved."
  ,"文献纲要保存失败。": "The literature outline could not be saved."
  ,"关闭独立编辑器": "Close independent editor"
  ,"独立编辑文稿有未保存更改，确认放弃吗？": "The independently edited manuscript has unsaved changes. Discard them?"
  ,"独立编辑文稿保存失败。": "The independently edited manuscript could not be saved."
  ,"编辑文稿": "Editing manuscript"
  ,"独立编辑器尚未就绪。": "The independent editor is not ready."
  ,"独立编辑文稿已保存；当前文稿和 Literature 正式简介/纲要未改变。": "The independently edited manuscript was saved; the current manuscript and the formal Literature intro/outline were not changed."
  ,"文献纲要": "Literature Outline"
  ,"围绕文献证据层、阅读工作量层和科研关联层管理文献，不替代 Zotero、EndNote、Mendeley 或 ReadPaper。": "Manage literature evidence, reading workload, and research links without replacing Zotero, EndNote, Mendeley, or ReadPaper."
  ,"阅读工作量概览": "Reading workload overview"
  ,"文献数": "Literature count"
  ,"阅读活动": "Reading activity"
  ,"精读 / 整理 / 复用": "Intensive / summarized / reused"
  ,"标题、作者、摘要、DOI": "Title, author, abstract, or DOI"
  ,"阅读状态": "Reading status"
  ,"重要性": "Importance"
  ,"等": "et al."
  ,"未命名文献": "Untitled literature"
  ,"未命名文稿": "Untitled manuscript"
  ,"DOI / URL": "DOI / URL"
  ,"作者年份": "Authors and Year"
  ,"类型来源": "Type and Source"
  ,"研究问题和对象": "Research question and object"
  ,"方法概要": "Method overview"
  ,"专属课题笔记": "Project-specific Notes"
  ,"编辑专属笔记": "Edit Project-specific Notes"
  ,"课题相关度建议": "Project relevance suggestion"
  ,"关联对象": "Related objects"
  ,"可借鉴方法": "Reusable methods"
  ,"可对比结论": "Comparable conclusions"
  ,"专属课题笔记已保存。": "Project-specific notes saved."
  ,"专属课题笔记保存失败。": "Project-specific notes could not be saved."
  ,"数量": "Count"
  ,"文献危险操作": "Literature Danger Zone"
  ,"删除文献": "Delete Literature"
  ,"AI分析入口已预留。": "AI Analysis entry reserved."
  ,"全部": "All"
  ,"单个标签": "Single tag"
  ,"含归档": "Include archived"
  ,"新建文献": "Create literature"
  ,"文献列表": "Literature list"
  ,"暂无文献。添加文献后，可记录阅读目的、阅读成果，并关联到课题、实验和成果。": "No literature yet. Add an item to record reading goals and outcomes and link it to projects, experiments, and outputs."
  ,"加载中": "Loading"
  ,"已归档": "Archived"
  ,"查看": "View"
  ,"恢复": "Restore"
  ,"归档": "Archive"
  ,"编辑文献": "Edit literature"
  ,"创建文献": "Create literature"
  ,"作者": "Authors"
  ,"年份": "Year"
  ,"来源 / 期刊会议": "Source / venue"
  ,"PDF 路径": "PDF path"
  ,"只保存路径，不保存 PDF 本体": "Store the path only, not the PDF file"
  ,"本地文件路径": "Local file path"
  ,"本地路径": "Local path"
  ,"只保存路径": "Store path only"
  ,"外部工具 ID": "External tool IDs"
  ,"每行 source|id|url，例如 zotero|ABC123": "One source|id|url per line, for example zotero|ABC123"
  ,"不强制归属；多对象关联请用 LiteratureLink": "Optional; use LiteratureLink for multiple targets"
  ,"可选主课题 ID": "Optional primary project ID"
  ,"摘要": "Summary"
  ,"保存文献": "Save literature"
  ,"文献已更新。": "Literature updated."
  ,"文献已创建。": "Literature created."
  ,"文献已恢复。": "Literature restored."
  ,"文献已归档。": "Literature archived."
  ,"正在创建新的文献条目。": "Creating a new literature item."
  ,"请先填写文献标题。": "Enter a literature title first."
  ,"耗时分钟": "Duration in minutes"
  ,"阅读目的": "Reading purpose"
  ,"逗号分隔，如 background, method_learning": "Comma-separated, such as background, method_learning"
  ,"读后状态": "Status after reading"
  ,"不变更": "No change"
  ,"阅读摘要": "Reading summary"
  ,"阅读结论": "Reading conclusion"
  ,"下一步": "Next action"
  ,"请先选择文献。": "Select a literature item first."
  ,"新增卡片": "Add card"
  ,"卡片类型": "Card type"
  ,"应用对象": "Application object"
  ,"数据来源": "Data source"
  ,"条件设置": "Condition setting"
  ,"方法核心": "Core method"
  ,"实验设计": "Experiment design"
  ,"对比方法": "Baseline methods"
  ,"评价指标": "Evaluation metrics"
  ,"主要结论": "Main conclusions"
  ,"局限性": "Limitations"
  ,"可借鉴点": "Reusable ideas"
  ,"内容": "Content"
  ,"阅读状态分布": "Reading-status distribution"
  ,"暂无研究问题": "No research problem"
  ,"暂无标签": "No tags"
  ,"未设置类型": "Type not set"
  ,"未确认": "Not confirmed"
  ,"已确认": "Confirmed"
  ,"成果转化工作区": "Output conversion workspace"
  ,"项目范围": "Project scope"
  ,"全部项目": "All projects"
  ,"结果资产库": "Result asset library"
  ,"暂无标记为资产的 ResultItem。": "No ResultItems are marked as assets."
  ,"查看资产": "View asset"
  ,"取消资产标记": "Remove asset mark"
  ,"已取消 ResultItem 的资产标记。": "ResultItem asset mark removed."
  ,"资产详情": "Asset details"
  ,"请选择一个结果资产查看详情。": "Select a result asset to view details."
  ,"创建关键发现": "Create finding"
  ,"编辑关键发现": "Edit finding"
  ,"置信度": "Confidence"
  ,"成熟度": "Maturity"
  ,"关联 ResultAsset": "Linked ResultAsset"
  ,"保存 Finding": "Save Finding"
  ,"创建 Finding": "Create Finding"
  ,"关键发现已更新。": "Finding updated."
  ,"关键发现已创建。": "Finding created."
  ,"暂无关键发现。": "No findings yet."
  ,"关键发现已归档。": "Finding archived."
  ,"Finding 详情": "Finding details"
  ,"请选择关键发现。": "Select a finding."
  ,"请选择关键发现以预览 Markdown。": "Select a finding to preview Markdown."
  ,"关联 ResultItem / ResultAsset": "Linked ResultItem / ResultAsset"
  ,"暂无关联结果项。": "No linked result items."
  ,"成果候选": "Output candidates"
  ,"创建成果候选": "Create output candidate"
  ,"编辑成果候选": "Edit output candidate"
  ,"关联 Finding": "Linked findings"
  ,"保存 Candidate": "Save Candidate"
  ,"创建 Candidate": "Create Candidate"
  ,"成果候选已更新。": "Output candidate updated."
  ,"成果候选已创建。": "Output candidate created."
  ,"暂无成果候选。": "No output candidates yet."
  ,"成果候选已归档。": "Output candidate archived."
  ,"成果候选详情": "Output candidate details"
  ,"暂无关联 Finding。": "No linked findings."
  ,"已取消 Candidate 与 Finding 的关联。": "Candidate-to-Finding link removed."
  ,"已取消 Candidate 与结果项的关联。": "Candidate-to-result-item link removed."
  ,"已取消 Finding 与结果项的关联。": "Finding-to-result-item link removed."
  ,"解绑": "Unlink"
  ,"请选择成果候选。": "Select an output candidate."
  ,"证据链": "Evidence chain"
  ,"请选择成果候选查看证据链。": "Select an output candidate to view its evidence chain."
  ,"新增成果缺口": "Add output gap"
  ,"编辑成果缺口": "Edit output gap"
  ,"保存 Gap": "Save Gap"
  ,"创建 Gap": "Create Gap"
  ,"成果缺口已更新。": "Output gap updated."
  ,"成果缺口已创建。": "Output gap created."
  ,"成果缺口": "Output gaps"
  ,"该候选暂无缺口。": "This candidate has no output gaps."
  ,"成果缺口已标记为处理中。": "Output gap marked as in progress."
  ,"成果缺口已标记解决。": "Output gap marked as resolved."
  ,"成果缺口已忽略。": "Output gap ignored."
  ,"成果缺口已删除。": "Output gap deleted."
  ,"处理中": "Set in progress"
  ,"解决": "Resolve"
  ,"忽略": "Ignore"
  ,"请选择成果候选以预览 Candidate Markdown。": "Select an output candidate to preview Candidate Markdown."
  ,"请选择成果候选以预览 Evidence Chain Markdown。": "Select an output candidate to preview Evidence Chain Markdown."
  ,"请选择成果候选以预览 AI Context。": "Select an output candidate to preview AI Context."
  ,"暂无成果转化汇总上下文。": "No output-conversion summary context."
  ,"请先创建或选择项目。": "Create or select a project first."
  ,"请先选择成果候选。": "Select an output candidate first."
  ,"优先级": "Priority"
  ,"项目": "Project"
  ,"取消": "Cancel"
  ,"无": "None"
  ,"AI ready 内容": "AI-ready content"
  ,"这些内容只作为后续 AI 记忆入口预览": "This content is only a preview for a future AI-memory entry point"
  ,"未变更": "Unchanged"
  ,"未填写作者": "No authors provided"
  ,"新增文献": "Add literature"
  ,"候选": "Candidates"
  ,"结果资产": "Result assets"
  ,"解决时间": "Resolved at"
  ,"来源": "Source"
  ,"描述": "Description"
  ,"未解决缺口": "Open gaps"
  ,"已关联 Candidate": "Linked candidates"
  ,"已关联 Finding": "Linked findings"
  ,"质量": "Quality"
  ,"资产": "Assets"
  ,"资产原因": "Asset reason"
  ,"结果项": "Result items"
  ,"结果项 → 结果资产视图 → 关键发现 → 成果候选 → 证据链 → 成果缺口": "ResultItem → ResultAsset view → Finding → OutputCandidate → Evidence Chain → OutputGap"
  ,"证据角色": "Evidence role"
  ,"关联强度": "Link strength"
  ,"可信度": "Confidence"
  ,"选择 Markdown 模板": "Select Markdown template"
  ,"选择后会插入到当前光标位置。": "The selected template will be inserted at the current cursor."
  ,"管理模板": "Manage templates"
  ,"关闭": "Close"
  ,"插入": "Insert"
  ,"内置模板": "Built-in template"
  ,"用户模板": "User template"
  ,"通用模板": "Common template"
  ,"暂无可用模板。": "No templates available."
  ,"新建模板": "New template"
  ,"编辑模板": "Edit template"
  ,"删除模板": "Delete template"
  ,"复制为用户模板": "Copy as user template"
  ,"重置模板": "Reset templates"
  ,"模板名称": "Template name"
  ,"模板说明": "Template description"
  ,"模板正文": "Template body"
  ,"保存模板": "Save template"
  ,"确认删除该用户模板？": "Delete this user template?"
  ,"确认重置当前范围的用户模板？": "Reset user templates for the current scope?"
  ,"模板名称和正文不能为空。": "Template name and body are required."
  ,"模板已保存。": "Template saved."
  ,"模板已删除。": "Template deleted."
  ,"已复制为用户模板。": "Copied as a user template."
  ,"副本": "Copy"
  ,"用户模板已重置。": "User templates reset."
  ,"模板操作失败。": "Template operation failed."
  ,"实验记录模板": "Experiment record template"
  ,"Run 记录模板": "Run record template"
  ,"通用记录模板": "Common record template"
  ,"用于记录实验目的、条件、方法、过程和结论。": "For recording experiment purpose, conditions, methods, process, and conclusions."
  ,"用于记录 Run 条件、变量、执行过程和结果。": "For recording run conditions, variables, execution process, and results."
  ,"用于记录通用背景、过程、结论和下一步。": "For recording general background, process, conclusions, and next steps."
  ,"关联文献关系": "Linked literature relations"
  ,"文献记录将移入回收站，并从默认文献列表隐藏。": "The literature record will be moved to the recycle area and hidden from the default literature list."
  ,"不会删除本地 PDF 或路径指向的真实文件。": "Local PDF files or real files referenced by paths will not be deleted."
  ,"不会读取、解析或上传本地文件正文。": "Local file contents will not be read, parsed, or uploaded."
  ,"文献关联关系不会级联删除。": "Literature links will not be cascade-deleted."
  ,"文献已移入回收站。": "Literature moved to the recycle area."
  ,"不会自动同步到结构化字段。": "It will not automatically sync to structured fields."
  ,"字符数": "Characters"
  ,"插入上下文摘要": "Insert context summary"
  ,"文献纲要 Markdown": "Literature Outline Markdown"
  ,"文献纲要 Markdown 已保存。": "Literature outline Markdown saved."
  ,"文献纲要 Markdown 保存失败。": "Failed to save literature outline Markdown."
  ,"专属课题笔记 Markdown": "Project-specific Notes Markdown"
  ,"专属课题笔记 Markdown 已保存。": "Project-specific notes Markdown saved."
  ,"专属课题笔记 Markdown 保存失败。": "Failed to save project-specific notes Markdown."
  ,"文献纲要正文模板": "Literature Outline Template"
  ,"用于自由整理这篇文献本身的内容。": "For freely organizing the content of this literature."
  ,"专属课题笔记正文模板": "Project-specific Notes Template"
  ,"用于自由整理这篇文献对当前课题的价值。": "For freely organizing the value of this literature to the current project."
};

const enumLabels: Record<string, { "zh-CN": string; "en-US": string }> = {
  planned: { "zh-CN": "计划中", "en-US": "Planned" },
  running: { "zh-CN": "运行中", "en-US": "Running" },
  completed: { "zh-CN": "已完成", "en-US": "Completed" },
  paused: { "zh-CN": "已暂停", "en-US": "Paused" },
  failed: { "zh-CN": "失败", "en-US": "Failed" },
  archived: { "zh-CN": "已归档", "en-US": "Archived" },
  cancelled: { "zh-CN": "已取消", "en-US": "Cancelled" },
  excellent: { "zh-CN": "优秀", "en-US": "Excellent" },
  good: { "zh-CN": "良好", "en-US": "Good" },
  usable: { "zh-CN": "可用", "en-US": "Usable" },
  inconclusive: { "zh-CN": "结论不明确", "en-US": "Inconclusive" },
  raw_data: { "zh-CN": "原始数据", "en-US": "Raw data" },
  processed_data: { "zh-CN": "处理后数据", "en-US": "Processed data" },
  code: { "zh-CN": "代码", "en-US": "Code" },
  config: { "zh-CN": "配置", "en-US": "Configuration" },
  model: { "zh-CN": "模型", "en-US": "Model" },
  figure: { "zh-CN": "图表", "en-US": "Figure" },
  table: { "zh-CN": "表格", "en-US": "Table" },
  log: { "zh-CN": "日志", "en-US": "Log" },
  report: { "zh-CN": "报告", "en-US": "Report" },
  paper_material: { "zh-CN": "论文材料", "en-US": "Paper material" },
  pdf: { "zh-CN": "PDF", "en-US": "PDF" },
  supplement: { "zh-CN": "补充材料", "en-US": "Supplement" },
  external_note: { "zh-CN": "外部阅读笔记", "en-US": "External reading note" },
  screenshot: { "zh-CN": "截图", "en-US": "Screenshot" },
  code_or_data: { "zh-CN": "代码或数据引用", "en-US": "Code or data reference" },
  attachment: { "zh-CN": "其他附件", "en-US": "Attachment" },
  other: { "zh-CN": "其他", "en-US": "Other" },
  number: { "zh-CN": "数值", "en-US": "Number" },
  text: { "zh-CN": "文本", "en-US": "Text" },
  percentage: { "zh-CN": "百分比", "en-US": "Percentage" },
  boolean: { "zh-CN": "布尔值", "en-US": "Boolean" },
  json: { "zh-CN": "JSON", "en-US": "JSON" }
  ,unread: { "zh-CN": "未读", "en-US": "Unread" }
  ,skimmed: { "zh-CN": "略读", "en-US": "Skimmed" }
  ,reading: { "zh-CN": "阅读中", "en-US": "Reading" }
  ,intensive_read: { "zh-CN": "精读", "en-US": "Intensive read" }
  ,summarized: { "zh-CN": "已整理", "en-US": "Summarized" }
  ,reused: { "zh-CN": "已复用", "en-US": "Reused" }
  ,discarded: { "zh-CN": "已弃用", "en-US": "Discarded" }
  ,core: { "zh-CN": "核心", "en-US": "Core" }
  ,important: { "zh-CN": "重要", "en-US": "Important" }
  ,useful: { "zh-CN": "有用", "en-US": "Useful" }
  ,background: { "zh-CN": "背景", "en-US": "Background" }
  ,uncertain: { "zh-CN": "不确定", "en-US": "Uncertain" }
  ,journal_article: { "zh-CN": "期刊论文", "en-US": "Journal article" }
  ,conference_paper: { "zh-CN": "会议论文", "en-US": "Conference paper" }
  ,review: { "zh-CN": "综述", "en-US": "Review" }
  ,book: { "zh-CN": "图书", "en-US": "Book" }
  ,book_chapter: { "zh-CN": "书籍章节", "en-US": "Book chapter" }
  ,thesis: { "zh-CN": "学位论文", "en-US": "Thesis" }
  ,patent: { "zh-CN": "专利", "en-US": "Patent" }
  ,standard: { "zh-CN": "标准", "en-US": "Standard" }
  ,technical_report: { "zh-CN": "技术报告", "en-US": "Technical report" }
  ,preprint: { "zh-CN": "预印本", "en-US": "Preprint" }
  ,dataset: { "zh-CN": "数据集", "en-US": "Dataset" }
  ,software: { "zh-CN": "软件", "en-US": "Software" }
  ,webpage: { "zh-CN": "网页", "en-US": "Webpage" }
  ,method_learning: { "zh-CN": "方法学习", "en-US": "Method learning" }
  ,experiment_design: { "zh-CN": "实验设计", "en-US": "Experiment design" }
  ,baseline_reproduction: { "zh-CN": "基线复现", "en-US": "Baseline reproduction" }
  ,writing_support: { "zh-CN": "写作支撑", "en-US": "Writing support" }
  ,related_work: { "zh-CN": "相关工作", "en-US": "Related work" }
  ,theory_support: { "zh-CN": "理论支撑", "en-US": "Theory support" }
  ,result_interpretation: { "zh-CN": "结果解释", "en-US": "Result interpretation" }
  ,patent_background: { "zh-CN": "专利背景", "en-US": "Patent background" }
  ,reproduce: { "zh-CN": "复现", "en-US": "Reproduce" }
  ,add_to_review: { "zh-CN": "加入复盘", "en-US": "Add to review" }
  ,link_to_experiment: { "zh-CN": "关联实验", "en-US": "Link to experiment" }
  ,link_to_output: { "zh-CN": "关联成果", "en-US": "Link to output" }
  ,extract_method: { "zh-CN": "提取方法", "en-US": "Extract method" }
  ,extract_baseline: { "zh-CN": "提取基线", "en-US": "Extract baseline" }
  ,temporarily_store: { "zh-CN": "暂存", "en-US": "Store temporarily" }
  ,discard: { "zh-CN": "弃用", "en-US": "Discard" }
  ,none: { "zh-CN": "无", "en-US": "None" }
  ,structured_card: { "zh-CN": "结构化卡片", "en-US": "Structured card" }
  ,method_card: { "zh-CN": "方法卡片", "en-US": "Method card" }
  ,experiment_card: { "zh-CN": "实验卡片", "en-US": "Experiment card" }
  ,baseline_card: { "zh-CN": "基线卡片", "en-US": "Baseline card" }
  ,theory_card: { "zh-CN": "理论卡片", "en-US": "Theory card" }
  ,writing_card: { "zh-CN": "写作卡片", "en-US": "Writing card" }
  ,critique_card: { "zh-CN": "批判性卡片", "en-US": "Critique card" }
  ,summary: { "zh-CN": "摘要", "en-US": "Summary" }
  ,not_applicable: { "zh-CN": "不适用", "en-US": "Not applicable" }
  ,project: { "zh-CN": "课题", "en-US": "Project" }
  ,route: { "zh-CN": "路线", "en-US": "Route" }
  ,task: { "zh-CN": "任务", "en-US": "Task" }
  ,experiment: { "zh-CN": "实验", "en-US": "Experiment" }
  ,experimentRun: { "zh-CN": "实验运行", "en-US": "Experiment run" }
  ,resultMetric: { "zh-CN": "结果指标", "en-US": "Result metric" }
  ,fileRef: { "zh-CN": "文件引用", "en-US": "File reference" }
  ,resultItem: { "zh-CN": "结果项", "en-US": "Result item" }
  ,finding: { "zh-CN": "关键发现", "en-US": "Finding" }
  ,outputCandidate: { "zh-CN": "成果候选", "en-US": "Output candidate" }
  ,output: { "zh-CN": "成果", "en-US": "Output" }
  ,aiContext: { "zh-CN": "AI 上下文", "en-US": "AI context" }
  ,background_support: { "zh-CN": "背景支撑", "en-US": "Background support" }
  ,core_related_work: { "zh-CN": "核心相关工作", "en-US": "Core related work" }
  ,method_reference: { "zh-CN": "方法参考", "en-US": "Method reference" }
  ,problem_source: { "zh-CN": "问题来源", "en-US": "Problem source" }
  ,baseline: { "zh-CN": "基线", "en-US": "Baseline" }
  ,parameter_reference: { "zh-CN": "参数参考", "en-US": "Parameter reference" }
  ,data_processing_reference: { "zh-CN": "数据处理参考", "en-US": "Data-processing reference" }
  ,evaluation_metric_reference: { "zh-CN": "评价指标参考", "en-US": "Evaluation-metric reference" }
  ,experiment_comparison: { "zh-CN": "实验对比", "en-US": "Experiment comparison" }
  ,contradicts: { "zh-CN": "存在矛盾", "en-US": "Contradicts" }
  ,extends: { "zh-CN": "扩展", "en-US": "Extends" }
  ,inspired_by: { "zh-CN": "受其启发", "en-US": "Inspired by" }
  ,introduction: { "zh-CN": "引言", "en-US": "Introduction" }
  ,method: { "zh-CN": "方法", "en-US": "Method" }
  ,discussion: { "zh-CN": "讨论", "en-US": "Discussion" }
  ,conclusion: { "zh-CN": "结论", "en-US": "Conclusion" }
  ,report_support: { "zh-CN": "汇报支撑", "en-US": "Report support" }
  ,future_work: { "zh-CN": "未来工作", "en-US": "Future work" }
  ,strong: { "zh-CN": "强", "en-US": "Strong" }
  ,weak: { "zh-CN": "弱", "en-US": "Weak" }
  ,confirmed: { "zh-CN": "已确认", "en-US": "Confirmed" }
  ,probable: { "zh-CN": "较可信", "en-US": "Probable" }
  ,tentative: { "zh-CN": "暂定", "en-US": "Tentative" }
  ,ai_suggested: { "zh-CN": "AI 建议", "en-US": "AI suggested" }
  ,research_problem: { "zh-CN": "研究问题", "en-US": "Research problem" }
  ,condition: { "zh-CN": "条件", "en-US": "Condition" }
  ,metric: { "zh-CN": "指标", "en-US": "Metric" }
  ,result: { "zh-CN": "结果", "en-US": "Result" }
  ,limitation: { "zh-CN": "局限", "en-US": "Limitation" }
  ,reusable_idea: { "zh-CN": "可复用想法", "en-US": "Reusable idea" }
  ,quote: { "zh-CN": "引文", "en-US": "Quote" }
  ,user_judgement: { "zh-CN": "用户判断", "en-US": "User judgement" }
  ,highest: { "zh-CN": "最高", "en-US": "Highest" }
  ,exclude: { "zh-CN": "排除", "en-US": "Exclude" }
  ,phenomenon: { "zh-CN": "现象", "en-US": "Phenomenon" }
  ,comparison: { "zh-CN": "对比", "en-US": "Comparison" }
  ,evidence: { "zh-CN": "证据", "en-US": "Evidence" }
  ,hypothesis: { "zh-CN": "假设", "en-US": "Hypothesis" }
  ,negative_result: { "zh-CN": "负结果", "en-US": "Negative result" }
  ,idea: { "zh-CN": "想法", "en-US": "Idea" }
  ,preliminary: { "zh-CN": "初步", "en-US": "Preliminary" }
  ,validated: { "zh-CN": "已验证", "en-US": "Validated" }
  ,ready_for_output: { "zh-CN": "可形成成果", "en-US": "Ready for output" }
  ,caseStudy: { "zh-CN": "案例研究", "en-US": "Case study" }
  ,presentation: { "zh-CN": "汇报", "en-US": "Presentation" }
  ,futureProject: { "zh-CN": "后续项目", "en-US": "Future project" }
  ,collecting: { "zh-CN": "材料收集中", "en-US": "Collecting" }
  ,drafting: { "zh-CN": "撰写中", "en-US": "Drafting" }
  ,validating: { "zh-CN": "验证中", "en-US": "Validating" }
  ,ready: { "zh-CN": "就绪", "en-US": "Ready" }
  ,converted: { "zh-CN": "已转化", "en-US": "Converted" }
  ,open: { "zh-CN": "未解决", "en-US": "Open" }
  ,in_progress: { "zh-CN": "处理中", "en-US": "In progress" }
  ,partiallyResolved: { "zh-CN": "部分解决", "en-US": "Partially resolved" }
  ,resolved: { "zh-CN": "已解决", "en-US": "Resolved" }
  ,ignored: { "zh-CN": "已忽略", "en-US": "Ignored" }
  ,data: { "zh-CN": "数据", "en-US": "Data" }
  ,analysis: { "zh-CN": "分析", "en-US": "Analysis" }
  ,validation: { "zh-CN": "验证", "en-US": "Validation" }
  ,theory: { "zh-CN": "理论", "en-US": "Theory" }
  ,literature: { "zh-CN": "文献", "en-US": "Literature" }
  ,writing: { "zh-CN": "写作", "en-US": "Writing" }
  ,note: { "zh-CN": "笔记", "en-US": "Note" }
  ,paper_draft: { "zh-CN": "论文草稿", "en-US": "Paper draft" }
  ,researchRecord: { "zh-CN": "科研记录", "en-US": "Research record" }
  ,manual: { "zh-CN": "手动录入", "en-US": "Manual" }
  ,sample: { "zh-CN": "样本", "en-US": "Sample" }
  ,case: { "zh-CN": "案例", "en-US": "Case" }
  ,document: { "zh-CN": "文档", "en-US": "Document" }
};

export function nonPlanningUi(language: Language, source: string) {
  return language === "zh-CN" ? source : englishUi[source] ?? source;
}

export function nonPlanningEnumLabel(language: Language, value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }
  return enumLabels[value]?.[language] ?? value;
}
