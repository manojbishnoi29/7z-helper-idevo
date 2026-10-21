# SevenZipJBinding Native Integration

This folder documents the real 7z password verification engine for the native Android build.

## Why this is needed

Expo Go / web preview cannot load native `.so` libraries. The JS app in this repo calls
`NativeModules.SevenZipModule` which is only available after a native Android build.

## Gradle dependencies

`android/app/build.gradle`:

```gradle
dependencies {
    implementation 'net.sf.sevenzipjbinding:sevenzipjbinding:16.02-2.01'
    implementation 'net.sf.sevenzipjbinding:sevenzipjbinding-all-platforms:16.02-2.01'
}
android {
    packagingOptions { pickFirst '**/libsevenzipjbinding.so' }
}
```

Or with version catalog / Kotlin DSL equivalent.

Native libs must be present for: arm64-v8a, armeabi-v7a, x86, x86_64 (provided by all-platforms artifact).

## Kotlin native module (SevenZipModule.kt)

Package: `com.sevenzrecovery.helper`

See `SevenZipModule.kt.example` in this folder for the full implementation.

Key responsibilities:
- `verifyPassword(archiveUri: String, password: String): Promise<String>` — opens archive via SAF fd + SevenZip, tries to extract/test first entry with password, returns "correct"/"incorrect"/"corrupted"/"unsupported"/"error:msg".
- `extractArchive(archiveUri, password, outputUri): Promise<Map>` — extracts all entries to SAF tree URI; must not overwrite existing files; reports progress.

Must use Storage Access Framework: `ContentResolver.openFileDescriptor(Uri.parse(archiveUri), "r")` and `SeekableInStream` wrapper.

## SAF file pickers

Provided by `expo-document-picker` (already integrated). In bare/native, alternatively use:
- `ActivityResultContracts.OpenDocument` for .7z and .txt
- `ActivityResultContracts.OpenDocumentTree` for extraction output

## Error handling (JS contract)

- incorrect password -> "incorrect"
- corrupted archive -> "corrupted"
- unsupported codec/encryption -> "unsupported"
- missing native lib -> native module not registered (JS returns engine_unavailable without calling native)

## Building

```
npx expo prebuild
cd android && ./gradlew assembleRelease
# or: eas build --platform android
```

## Security

- Never log passwords
- Never upload archives/candidates
- Clear password strings after use (Kotlin: zero char arrays where possible)
