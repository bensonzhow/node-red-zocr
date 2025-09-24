module.exports = function (RED) {
    "use strict";
    // const path = require('path');
    // const fs = require('fs').promises;
    // const sharp = require('sharp');
    const { createWorker } = require('tesseract.js');

    function zocr(n) {
        RED.nodes.createNode(this, n);
        var node = this;

        this.on("input", function (msg, send, done) {
            // Download URL
            if (/^http(s?):\/\//.test(msg.payload)) {
                node.status({ fill: "blue", shape: "dot", text: "downloading image" });
                request({ url: msg.payload, encoding: null }, function (err, res, body) {
                    if (err) {
                        node.error("Encountered error while downloading image file. " + err.message);
                    }
                    msg.payload = body;
                    Recognize(msg,done);
                });
            }
            // Open file on local file system
            else if (typeof msg.payload == "string") {
                if (fs.existsSync(msg.payload)) {
                    Recognize(msg,done);
                }
                else {
                    node.error("Referenced image file does not exist.");
                }
            }
            // Buffer
            else {
                Recognize(msg,done);
            }

        });


        async function Recognize(msg,done) {
            // Update status - Starting
            node.status({ fill: "blue", shape: "dot", text: "performing ocr" });
            try {
                let zocrConfig = Object.assign(msg.zocrConfig, {
                    lang: 'eng',
                    tessedit_char_whitelist: '0123456789',
                    // preserve_interword_spaces: '1', // 保留单词间距
                    tessedit_pageseg_mode: '6',     // 单行文本模式
                });;
                const worker = await createWorker(zocrConfig.lang);

                await worker.setParameters(zocrConfig);
                const res = await worker.recognize(msg.payload);
                await worker.terminate();
                msg.payload = res;
                node.send(msg);
                // Update status - Done
                node.status({});
                done();
            } catch (error) {
                node.error(error);
                done();
            }
        }
    }
    RED.nodes.registerType("zocr", zocr);

}
