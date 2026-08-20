# 酒馆视频自动生成插件
利用酒馆自带的生图插件来生成视频，只支持comfyUI生成视频，仓库中有comfyUI视频生成工作流。

参考酒馆图片自动生成插件开发了视频自动生成插件。
图片自动生成插件原地址：https://github.com/wickedcode01/st-image-auto-generation

**功能介绍**
- <img width="476" height="265" alt="image" src="https://github.com/user-attachments/assets/dcd07111-b73f-4c41-8cae-e9e7ae3c1059" />

- 1.AI回复的消息中包含有`[video]提示词[/video]` 标签时，可触发自动生成视频。
- 2.也支持图片生成功能，只支持行内替换模式，`[image]提示词[/image]`格式触发生图
- 3.只支持世界书生图或者生成视频
- 4.支持自定义图片/视频的样式配置

**触发标签说明**
- 图片：`[image]SD提示词[/image]`；视频：`[video]SD提示词[/video]`。提示词写在标签体内，引号、换行都不会破坏标签结构；AI 偶尔漏写闭合标签时按行内内容兜底触发。
- 旧的 `<pic prompt="...">` / `<video prompt="...">` 属性式格式已废弃，不再识别。

**发给 LLM 前的还原（ST 正则扩展配置，必读）**

生成完成的图片/视频在聊天记录里是 mag-media wrapper（span 包裹）。本插件**不再**在发送前把它还原成触发标签，请用酒馆自带的**正则（Regex）扩展**配置还原，否则 wrapper（含 base64 图片数据）会原样进入 LLM 上下文：

- 打开 `扩展 → 正则（Regex）`，新建两条脚本：

**图片规则**
```
Find Regex:    /<span class="mag-(?:media|placeholder)[^"]*"(?=[^>]*\bdata-media-type="image")(?=[^>]*\bdata-prompt="([^"]*)")[^>]*>[\s\S]*?<\/span>/g
Replace With:  [image]$1[/image]
```

**视频规则**
```
Find Regex:    /<span class="mag-(?:media|placeholder)[^"]*"(?=[^>]*\bdata-media-type="video")(?=[^>]*\bdata-prompt="([^"]*)")[^>]*>[\s\S]*?<\/span>/g
Replace With:  [video]$1[/video]
```

- 两条都勾选：作用于 **AI Output**；选项勾 **Only Format Prompt**（只改发送给 LLM 的内容，不改聊天记录与显示）；不勾 Run on Edit。
- 作用：wrapper / 占位符整体（含 base64）被折叠回 `[image]提示词[/image]`，LLM 看到的始终是干净的触发标签，也就不会模仿输出 wrapper HTML。

**comfyUI生成视频介绍**
- comfyUI生成视频的成本较高，无论是学习成本还是硬件成本。

**电脑硬件和生成时长参考**
- 本人电脑配置如下：
- 5080 16G显卡+64G内存，使用该工作流生成320*320视频耗时25s,320*480耗时30s,480*480耗时40s,480*720耗时50s

**简易教程**
- 1.本地comfyUI环境必须安装sega加速，不然龟速，使用wan2.2的smooth mix模型。新手建议到b站找个带sega加速的整合包。
- 2.将仓库中的comfyui-flow.json拖到comfyUI中，然后去下载里面所需的各种模型，lora就自己去搭配下载吧，支持2个lora，能跑起来以后把comfyui-flow.json中的lora_name改成自己下的lora（也可以直接在插件ComfyUI配置tab的LoRA列表里新增/删除，点『连接』后下拉可选ComfyUI里已装的lora）
- 3.把改好的json复制到酒馆生图插件中的comfyUI工作流里保存
- 4.正面提示词和负面提示词自己填，正面提示词一定要加上${promot}
- 5.改分辨率，工作流里的节点17就是分辨率配置
- <img width="540" height="325" alt="image" src="https://github.com/user-attachments/assets/6245ab43-ecb9-469c-9de5-a918b14ad214" />

- <img width="505" height="670" alt="image" src="https://github.com/user-attachments/assets/96703bca-b2ca-4fc8-a6c9-e9e555f267c5" />
- <img width="859" height="850" alt="image" src="https://github.com/user-attachments/assets/a9c05c85-e8f7-495d-b472-8ec3cc9a4e71" />
- <img width="415" height="235" alt="image" src="https://github.com/user-attachments/assets/c9d408d1-b9d8-4579-ba92-1ac0c64fa661" />


**放大模型（可选）**

- ComfyUI 配置 tab 里 Sampler/Scheduler 下方有「放大模型」下拉，列出 ComfyUI `models/upscale_models` 目录下的模型（点『连接』刷新列表）。
- 默认「不使用」。选中后**每次生成时**自动在工作流的输出节点（预览图像/保存图像等）前插入 `UpscaleModelLoader` + `ImageUpscaleWithModel` 放大链——配置档里存的工作流 JSON 不会被改动；工作流本身已带放大链时只替换其中的模型名。
- 模型放大是像素级放大（图片会变大变清晰，耗时也增加）；视频工作流同样适用（逐帧放大，明显变慢）。
- 下拉列表由浏览器直连 ComfyUI 获取，**要求 ComfyUI 启动时带 `--enable-cors-header` 参数**（否则跨域被拒，拉不到列表，但仍会回显已保存的选择）。LoRA 新增下拉的模型列表获取方式相同，同样依赖该参数。

**列表缓存**

- 点『连接』拉到的模型 / 采样器 / 调度器 / LoRA / 放大模型列表会按 ComfyUI 地址自动保存。之后刷新页面、重开酒馆、切换配置档、地址簿切走再切回，都直接用保存的列表，**不需要再点『连接』**；再次点『连接』则刷新为最新列表。
