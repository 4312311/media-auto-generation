# 酒馆视频自动生成插件
利用酒馆自带的生图插件来生成视频，只支持comfyUI生成视频，仓库中有comfyUI视频生成工作流。


参考酒馆图片自动生成插件开发了视频自动生成插件。
图片自动生成插件原地址：https://github.com/wickedcode01/st-image-auto-generation

**功能介绍**
<img width="505" height="670" alt="image" src="https://github.com/user-attachments/assets/c26308f6-1c29-44b2-b812-94c48bb8459a" />

1.AI回复的消息中包含有`<video prompt="...">` 标签时，可触发自动生成视频。
2.也支持图片生成功能，但是比较简陋，只支持行内替换模式，默认是<img prompt="...">格式才触发生图
3.只支持世界书生图或者生成视频
4.支持自定义图片/视频的样式配置

**comfyUI生成视频介绍**
comfyUI生成视频的成本较高，无论是学习成本还是硬件成本。

**电脑硬件和生成时长参考**
本人电脑配置如下：
5080 16G显卡+64G内存，使用该工作流生成320*320视频耗时25s,320*480耗时30s,480*480耗时40s,480*720耗时50s

**简易教程**
1.本地comfyUI环境必须安装sega加速，不然龟速，使用wan2.2的smooth mix模型。新手建议到b站找个带sega加速的整合包。
2.将仓库中的comfyui-flow.json拖到comfyUI中，然后去下载里面所需的各种模型，lora就自己去搭配下载吧，支持2个lora，能跑起来以后把comfyui-flow.json中的lora_name改成自己下的lora
3.把改好的json复制到酒馆生图插件中的comfyUI工作流里保存
<img width="505" height="670" alt="image" src="https://github.com/user-attachments/assets/96703bca-b2ca-4fc8-a6c9-e9e555f267c5" />
<img width="859" height="850" alt="image" src="https://github.com/user-attachments/assets/a9c05c85-e8f7-495d-b472-8ec3cc9a4e71" />
4.正面提示词和负面提示词自己填，正面提示词一定要加上${promot}
<img width="540" height="325" alt="image" src="https://github.com/user-attachments/assets/6245ab43-ecb9-469c-9de5-a918b14ad214" />
5.改分辨率，工作流里的节点17就是分辨率配置
<img width="415" height="235" alt="image" src="https://github.com/user-attachments/assets/c9d408d1-b9d8-4579-ba92-1ac0c64fa661" />


