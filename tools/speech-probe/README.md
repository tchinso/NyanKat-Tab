# Japanese Parakeet CTC browser probe

This standalone experiment runs the Japanese Parakeet 0.6B INT8 CTC model
unchanged using ONNX Runtime Web 1.31.1. It does not depend on Transformers.js.
Inference runs in a module Worker. The extension UI is not connected yet.

## Model artifacts

Place these files in a directory outside the repository:

| Local filename | Source |
| --- | --- |
| model.int8.onnx | https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/model.int8.onnx |
| tokens.txt | https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/tokens.txt |
| test.wav | https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/test_wavs/test_ja_1.wav |
| nemo80.onnx | https://huggingface.co/visuall/parakeet-tdt_ctc-0.6b-ja-onnx/resolve/21425daf1cb77f13773b894ca028d607d3f40758/nemo80.onnx |

The acoustic model is approximately 655 MB. The frontend converts 16 kHz audio
to normalized 80-bin log-mel features, matching the Japanese model's input.
Browser audio decoding resamples the sample WAV (48 kHz) to 16 kHz.
The CTC decoder removes blanks and collapses consecutive equal token IDs,
preserving repeats separated by a blank.

Model attribution: NVIDIA NeMo `nvidia/parakeet-tdt_ctc-0.6b-ja` (CC BY 4.0);
CTC ONNX conversion by k2-fsa/sherpa-onnx; frontend ONNX by visuall (CC BY 4.0).
See their model cards for attribution and conversion details. No model files
are redistributed in this repository. No RealTimeSubtitle code is used.

## Run

From the repository root:

```text
node tools/speech-probe/serve.mjs <model-directory>
```

Open http://127.0.0.1:8879/tools/speech-probe/index.html?threads=1
or use `threads=4` to test multithreading. The loopback-only server supplies
COOP/COEP headers required for SharedArrayBuffer. A future extension must
configure and verify cross-origin isolation for its inference context too.

Use `?threads=1&isolation=off&seconds=3` to test a three-second chunk without
cross-origin isolation. Single-threaded WASM does not require SharedArrayBuffer.

The page reports loading time, inference time, transcript, and real-time factor
(inference seconds / audio seconds; below 1 is faster than playback).
This is a single-utterance probe, not a continuous streaming benchmark.
GPU execution, extension lifecycle, VAD, translation, caching, and caption UI
remain integration work. Large model loading can need substantially more
memory than the model file size.

## Measured on 2026-11-02

Actual headless Chrome 156.0.8078.76, AMD Ryzen 5 4500U (6 logical CPUs),
Playwright 1.62.1, WASM SIMD in a module Worker. One run per configuration:

| Audio | Threads | Cross-origin isolated | Load | Inference | RTF |
| --- | --- | --- | --- | --- | --- |
| 13 s | 1 | yes | 14.57 s | 5.31 s | 0.408 |
| 13 s | 4 | yes | 13.00 s | 14.41 s | 1.109 |
| 3 s | 1 | no | 18.61 s | 1.84 s | 0.613 |

The full-utterance browser transcript was:
`日本ちゃんと聞っといてますか?ちゃんと聞こえてんの?ちゃんと聞こえてんの?ってマイクを持ってもらって。`

The three-second transcript was `日本語ちゃんと切っといてますか?`.
The reference begins `日本語ちゃんと聞き取れてますか`; recognition is functional
but these substitutions show that accuracy and segmentation still need evaluation.
The shared frontend was published with a TDT export; normalization and acoustic
feature parity with the native CTC reference should be checked before finalizing it.
These measurements establish browser execution, not production subtitle quality
or sustained performance. Translation, segment accumulation, and scheduling add
latency. Model load occurs once per inference-worker lifetime. Use one WASM thread
as the initial baseline on this machine; more threads were slower in this run.

The same runtime was also exercised in Node's single-threaded WASM mode, but its
timings are not used as browser performance measurements. Source syntax checks
passed for all three JavaScript modules.
