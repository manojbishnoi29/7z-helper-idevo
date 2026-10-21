# Build Instructions — 7z Password Recovery Helper

## Preview (Expo Go / Web)

```
bun install
bun run dev
```

Runs in Expo Go / web. Picks .7z and .txt via system picker, parses TXT (UTF-8 BOM, CRLF/LF, order preserved), shows progress.
Real decryption does NOT run in Expo Go — app shows `engine_unavailable` and offers Mock mode (DemoPass123) to test flows.

## Native Android Build (real 7z verification)

Requires SevenZipJBinding native libs.

```
npx expo prebuild
# add dependencies to android/app/build.gradle (see native/README.md)
cd android && ./gradlew assembleRelease
# or: eas build --platform android --profile production
```

After native build, `NativeModules.SevenZipModule` is linked and `verifyPassword` does real AES-256 7zAES decryption.

## Testing

- TXT parsing: import a file with CRLF, BOM, and spaces inside passwords — order must be preserved.
- Ordered checking: put DemoPass123 at line 5, add 4 wrong passwords above — with Mock ON, success should report line 5.
- Cancellation: Start recovery with 50+ candidates and press Stop — must stop cleanly, no duplicate jobs.
- Failure: list with no correct password -> "No matching password..." with Import Another / Edit / Run Again.
