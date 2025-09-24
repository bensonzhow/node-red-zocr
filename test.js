(async () => {
    try {
        const path = require('path');
        const fs = require('fs').promises;

        const sharp = require('sharp');
        const { createWorker } = require('tesseract.js');
        let imgPath = path.join(__dirname,'./images/test11111_20250925015618.png');
        const imageBuffer = await fs.readFile(imgPath);

        const metadata = await sharp(imageBuffer).metadata();
        const { width, height } = metadata;

        // 动态裁剪：取中间部分（例如 40% 宽，25% 高）
        // const cropWidth = Math.floor(width * 0.55);
        // const cropHeight = Math.floor(height * 0.15);
        // const left = Math.floor((width - cropWidth) / 2);
        // const top = Math.floor((height - cropHeight) / 2);
        const cropWidth = 1000;
        const cropHeight = 150;
        const left = 680;
        const top = 870;
        // x:580,
        // y:762,
        // w:1000,
        // h:150,
        // 图像处理链 - 优化版本
        // .greyscale()                    // 转灰度
        //     .resize(Math.floor(width * 2), null) // 放大2倍，提升细节（可选）
        //     // .linear(2.5, -160)              // 强对比度拉伸：增强暗部，压亮过曝区
        //     .linear(1.8, -60)              // 强对比度拉伸：增强暗部，压亮过曝区
        //     .threshold(50)                 // 二值化：低于120变黑，高于变白
        //     .sharpen({ sigma: 4 })          // 轻度锐化
        //     .toFormat('png')
        //     .toBuffer();
        const processedBuffer = await sharp(imageBuffer)
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .greyscale()                    // 转灰度
            .resize(Math.floor(cropWidth * 2), null) // 放大2倍，提升细节（使用裁剪后的宽度）
            // 针对过曝区域优化处理
            .modulate({ 
                brightness: 0.7,   // 显著降低亮度以减少过曝影响
                contrast: 2.0      // 增强对比度以提高文字清晰度
            })
            .linear(5.5, -160)              // 温和的对比度拉伸参数，避免丢失细节
            .median(3)                     // 中值滤波，减少噪声
            .threshold(40)                // 调整二值化阈值，适配处理后的图像（较高阈值处理白底黑字）
            .sharpen({ sigma: 1 })       // 轻度锐化
            .toFormat('png')
            .toBuffer();

        await fs.writeFile(path.join(__dirname,'./images/processed.png'), processedBuffer);

        // 执行OCR识别
        const worker = await createWorker('eng');

        await worker.setParameters({
            tessedit_char_whitelist: '0123456789',
            // preserve_interword_spaces: '1', // 保留单词间距
            tessedit_pageseg_mode: '6',     // 单行文本模式
        });
        const { data: { text } } = await worker.recognize(processedBuffer);
        console.log(text);
        await worker.terminate();
    } catch (error) {
        console.error('OCR识别过程中发生错误:', error);
    }
})();