# R8 keep rules for the release build.
#
# Compose, AndroidX and kotlinx.serialization ship their own consumer rules, and the app has no
# reflection of its own yet, so nothing extra is kept. Add rules here when code starts to rely on
# reflection (for example a serializer looked up by name) and check the release build on a device.
