# R8 keep rules for the release build.
#
# Compose, AndroidX and kotlinx.serialization ship their own consumer rules. Add rules here when code
# starts to rely on reflection (for example a serializer looked up by name) and check the release
# build on a device.

# ONNX Runtime's native library finds its Java classes, constructors and fields through JNI by
# name (ai.onnxruntime.OnnxTensor, OrtSession$Result and others), and its AAR keeps only its
# telemetry classes, so the whole Java API is kept. It is about 140 KB of classes.
-keep class ai.onnxruntime.** { *; }
