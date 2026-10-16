# gomobile: the generated bindings are reached from native code by name.
-keep class go.** { *; }
-keep class io.booksync.core.** { *; }
# kotlinx.serialization keeps generated serializers itself (rules ship with
# the library); our models need nothing extra.
