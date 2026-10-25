# Third-party notices

ProMatch ships the following third-party components. Each keeps its own licence.

| Component | Where | Licence | Source |
| --- | --- | --- | --- |
| OpenCV.js 4.12 (`@techstark/opencv-js`) | `vendor/opencv.js` | Apache License 2.0 | https://github.com/TechStark/opencv-js, https://github.com/opencv/opencv |
| YuNet face detector (`face_detection_yunet_2023mar.onnx`) | `vendor/` | MIT | https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet |
| MediaPipe Face Mesh landmark model (`face_landmark.tflite`) | `vendor/` | Apache License 2.0 | https://github.com/google-ai-edge/mediapipe |
| Adobe CSInterface.js 10.0 | `vendor/CSInterface.js` | Adobe CEP licence (redistributable with CEP extensions) | https://github.com/Adobe-CEP/CEP-Resources |

The ProMatch effect (`ProMatch.aex`) is built with the Adobe After Effects SDK and Premiere Pro
SDK. The SDKs themselves are not distributed (they stay in the gitignored `native/sdk/`).

The full Apache License 2.0 text is at https://www.apache.org/licenses/LICENSE-2.0 and the MIT
licence text is at https://opensource.org/license/mit. Copies are kept with each component's
source listed above.
