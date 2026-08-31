import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-i18n-"));
const entryPath = join(tempDir, "test-entry.ts");
const bundlePath = join(tempDir, "test-entry.mjs");

try {
  await writeFile(entryPath, testSource(), "utf8");
  await build({
    entryPoints: [entryPath],
    alias: {
      "#agent-protocol/locale-registry": resolve(projectRoot, "packages/agent-protocol/src/locale-registry.ts"),
      "@opengrove/agent-protocol/locale-registry": resolve(
        projectRoot,
        "packages/agent-protocol/src/locale-registry.ts",
      ),
    },
    bundle: true,
    define: {
      "import.meta.env.DEV": "false",
    },
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
  console.log("web i18n harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function testSource() {
  const dictionaryPath = resolve(projectRoot, "web/src/i18n-dictionaries.ts");
  const localeRegistryPath = resolve(projectRoot, "packages/agent-protocol/src/locale-registry.ts");
  const hostMessagesPath = resolve(projectRoot, "src/localization/host-messages.ts");
  const i18nPath = resolve(projectRoot, "web/src/i18n.ts");
  const pluralPath = resolve(projectRoot, "web/src/i18n-plurals.ts");
  const localePath = resolve(projectRoot, "web/src/locale.ts");
  const intlFormattersPath = resolve(projectRoot, "web/src/intl-formatters.ts");
  const languageSettingsSyncPath = resolve(projectRoot, "web/src/language-settings-sync.ts");
  const legacyRoomMessagePath = resolve(projectRoot, "web/src/components/rooms/rooms-legacy-message-normalization.ts");
  const appStorePublishModelPath = resolve(projectRoot, "web/src/components/network/app-store-publish-model.ts");
  const hostLanguagePreferencePath = resolve(projectRoot, "src/server/language-preference.ts");
  return `
    import assert from "node:assert/strict";
    import { dictionaries, EN, ZH_CN } from ${JSON.stringify(dictionaryPath)};
    import { SUPPORTED_LOCALES } from ${JSON.stringify(localeRegistryPath)};
    import { HOST_MESSAGE_CATALOGS } from ${JSON.stringify(hostMessagesPath)};
    import { rawDiagnosticText, translateInLanguage } from ${JSON.stringify(i18nPath)};
    import { englishCountKeyHasExplicitPolicy } from ${JSON.stringify(pluralPath)};
    import { cachedCollator, cachedDateTimeFormat, cachedNumberFormat } from ${JSON.stringify(intlFormattersPath)};
    import { nextLanguageSettingsBackfill } from ${JSON.stringify(languageSettingsSyncPath)};
    import { normalizeClientConnectorHelpText } from ${JSON.stringify(legacyRoomMessagePath)};
    import { releaseErrorMessage } from ${JSON.stringify(appStorePublishModelPath)};
    import {
      normalizeHostLanguagePreference,
      normalizeHostSystemLanguage,
      resolveHostLanguageSettings,
    } from ${JSON.stringify(hostLanguagePreferencePath)};
    import {
      canonicalizeLanguageTag,
      detectBrowserLanguage,
      pseudoLocalizeTemplate,
      resolveSupportedLanguage,
    } from ${JSON.stringify(localePath)};

    assert.equal(canonicalizeLanguageTag("EN_us"), "en-US");
    assert.equal(canonicalizeLanguageTag(" zh-hant-tw "), "zh-Hant-TW");
    assert.equal(resolveSupportedLanguage("en-GB"), "en");
    assert.equal(resolveSupportedLanguage("zh-Hans-SG"), "zh-CN");
    assert.equal(resolveSupportedLanguage("zh-Hant-HK"), "zh-CN");
    assert.equal(resolveSupportedLanguage("ja-JP"), "en");
    assert.equal(resolveSupportedLanguage(["ja-JP", "en-AU"]), "en");
    assert.equal(resolveSupportedLanguage(["invalid_tag", "zh-TW"]), "zh-CN");
    assert.equal(resolveSupportedLanguage("zh_CN.UTF-8"), "zh-CN");
    assert.equal(detectBrowserLanguage({ languages: ["fr-FR"], language: "zh-CN" }), "zh-CN");
    assert.equal(detectBrowserLanguage({ languages: ["fr-FR"], language: "fr-FR" }), "en");
    assert.equal(normalizeHostLanguagePreference("en"), "en");
    assert.equal(normalizeHostLanguagePreference("ja-JP", "zh-CN"), "zh-CN");
    assert.equal(normalizeHostLanguagePreference(undefined), undefined);
    assert.equal(normalizeHostSystemLanguage("zh-CN"), "zh-CN");
    assert.equal(normalizeHostSystemLanguage("system"), undefined);
    assert.equal(
      resolveHostLanguageSettings(
        { languagePreference: "system", systemLanguage: "zh-CN" },
        ["en-US"],
      ),
      "zh-CN",
    );

    const referenceKeys = Object.keys(EN).sort();
    for (const locale of SUPPORTED_LOCALES) {
      const localeKeys = Object.keys(dictionaries[locale]).sort();
      const missing = referenceKeys.filter((key) => !localeKeys.includes(key));
      const extra = localeKeys.filter((key) => !referenceKeys.includes(key));
      console.log(
        \`Web catalog \${locale}: missing \${missing.length ? missing.join(", ") : "(none)"}; extra \${extra.length ? extra.join(", ") : "(none)"}\`,
      );
      assert.deepEqual(missing, [], \`missing Web catalog keys for \${locale}\`);
      assert.deepEqual(extra, [], \`extra Web catalog keys for \${locale}\`);
    }
    const hostReferenceKeys = Object.keys(HOST_MESSAGE_CATALOGS.en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      const localeKeys = Object.keys(HOST_MESSAGE_CATALOGS[locale]).sort();
      const missing = hostReferenceKeys.filter((key) => !localeKeys.includes(key));
      const extra = localeKeys.filter((key) => !hostReferenceKeys.includes(key));
      console.log(
        \`Host catalog \${locale}: missing \${missing.length ? missing.join(", ") : "(none)"}; extra \${extra.length ? extra.join(", ") : "(none)"}\`,
      );
      assert.deepEqual(missing, [], \`missing Host catalog keys for \${locale}\`);
      assert.deepEqual(extra, [], \`extra Host catalog keys for \${locale}\`);
      for (const key of hostReferenceKeys) {
        assert.deepEqual(
          placeholders(HOST_MESSAGE_CATALOGS[locale][key]),
          placeholders(HOST_MESSAGE_CATALOGS.en[key]),
          \`Host placeholder mismatch for \${locale}.\${key}\`,
        );
      }
    }
    const zhKeys = Object.keys(ZH_CN).sort();
    const enKeys = Object.keys(EN).sort();
    assert.deepEqual(enKeys, zhKeys, "English and Chinese catalogs must expose exactly the same keys");
    for (const key of zhKeys) {
      assert.deepEqual(
        placeholders(EN[key]),
        placeholders(ZH_CN[key]),
        \`placeholder mismatch for \${key}\`,
      );
      if (key !== "settings.languageChinese") {
        assert.equal(/[\\u3400-\\u9fff]/u.test(EN[key]), false, \`unexpected Han characters in EN.\${key}\`);
      }
      if (EN[key].includes("{count}")) {
        assert.equal(englishCountKeyHasExplicitPolicy(key), true, \`count key lacks plural review: \${key}\`);
      }
    }

    assert.equal(translateInLanguage("en", "settings.modelsCount", { count: 1 }), "1 model");
    assert.equal(translateInLanguage("en", "settings.modelsCount", { count: 2 }), "2 models");
    assert.equal(translateInLanguage("en", "settings.modelsCount", { count: 1000 }), "1,000 models");
    assert.equal(translateInLanguage("zh-CN", "settings.modelsCount", { count: 1 }), "1 个模型");
    assert.equal(
      translateInLanguage("en", "conversation.defaultProjectTitle", { date: 2026 }),
      "New project 2026",
      "ordinary numeric placeholders must not gain thousands separators",
    );
    assert.equal(
      translateInLanguage("en", "system.partialAttachments", { selected: 1, count: 10 }),
      "Added the first 1 attachment; the limit is 10.",
    );
    assert.equal(
      translateInLanguage("en", "conversation.deleteProjectConfirm", { title: "Alpha", count: 1 }),
      "Delete project “Alpha”? Its 1 chat will also be removed from the local sidebar.",
    );
    assert.equal(
      rawDiagnosticText("服务暂时不可用"),
      "服务暂时不可用",
      "raw diagnostics remain intact instead of being classified by writing system",
    );
    assert.equal(
      rawDiagnosticText("Connection refused"),
      "Connection refused",
    );
    assert.equal(
      rawDiagnosticText(""),
      "",
    );
    const localBuildErrorCodes = [
      "app_release_local_build_timed_out",
      "app_release_local_build_timeout_invalid",
      "app_release_local_build_cancelled",
      "app_release_local_build_command_unavailable",
      "app_release_local_build_in_progress",
      "app_release_local_build_install_changed",
      "app_release_local_build_manifest_invalid",
      "app_release_local_build_platform_unsupported",
      "app_release_local_build_output_changed",
      "app_release_local_build_output_depth_exceeded",
      "app_release_local_build_output_entry_count_exceeded",
      "app_release_local_build_output_entry_type",
      "app_release_local_build_output_file_count_exceeded",
      "app_release_local_build_output_file_too_large",
      "app_release_local_build_output_missing",
      "app_release_local_build_output_path_collision",
      "app_release_local_build_output_protected",
      "app_release_local_build_output_symlink",
      "app_release_local_build_output_too_large",
      "app_release_local_build_output_working_directory",
      "app_release_local_build_outputs_overlap",
      "app_release_local_build_path_invalid",
    ];
    const translateZh = (key, replacements = {}) => translateInLanguage("zh-CN", key, replacements);
    const translateEn = (key, replacements = {}) => translateInLanguage("en", key, replacements);
    for (const code of localBuildErrorCodes) {
      assert.notEqual(
        releaseErrorMessage(translateZh, code),
        code,
        code + " must be rendered as actionable Chinese instead of an internal code",
      );
      assert.notEqual(
        releaseErrorMessage(translateEn, code),
        code,
        code + " must be rendered as actionable English instead of an internal code",
      );
    }
    assert.equal(
      releaseErrorMessage(translateZh, "app_release_local_build_timed_out"),
      "本机发布构建超时并已停止。远端发布尚未创建，请检查构建命令耗时后重试。",
    );
    assert.equal(
      releaseErrorMessage(translateEn, "app_release_local_build_command_unavailable"),
      "OpenGrove could not start a command from the local build recipe. Check that the executable or dependency is installed, then retry; no remote release was created.",
    );
    assert.equal(
      releaseErrorMessage(translateZh, "app_release_local_build_output_file_count_exceeded"),
      "本机构建产物的文件数量、大小或目录深度超出发布上限。请缩小声明的产物范围后重试；远端发布尚未创建。",
    );
    assert.equal(
      releaseErrorMessage(translateEn, "app_release_local_build_output_symlink"),
      "The local build output contains a symbolic link or unsupported file type. Replace it with regular files and directories, then retry; no remote release was created.",
    );
    assert.equal(
      releaseErrorMessage(translateZh, "app_release_local_build_output_protected"),
      "本机构建产物或配方包含不安全、受保护或互相冲突的路径。请修正生成文件或 .opengrove-build.json 后重试；远端发布尚未创建。",
    );
    assert.equal(
      normalizeClientConnectorHelpText("旧说明保持原样"),
      "旧说明保持原样",
    );
    assert.equal(
      normalizeClientConnectorHelpText("run legacy-cloud-connector --pairing-code SECRET_123 --cloud-url https://secret.example"),
      "run legacy-cloud-connector --pairing-code [redacted] --cloud-url [redacted]",
      "legacy Connector content remains verbatim except for credential-bearing arguments",
    );
    assert.equal(cachedNumberFormat("en"), cachedNumberFormat("en"));
    assert.equal(
      cachedCollator("en", { numeric: true }),
      cachedCollator("en", { numeric: true }),
    );
    assert.equal(
      cachedDateTimeFormat("en", { dateStyle: "medium" }),
      cachedDateTimeFormat("en", { dateStyle: "medium" }),
    );

    const firstBackfill = nextLanguageSettingsBackfill({
      localPreference: "system",
      detectedSystemLanguage: "zh-CN",
      settingsAvailable: true,
      mutationPending: false,
      lastAttemptKey: "",
    });
    assert.deepEqual(firstBackfill, {
      attemptKey: "system:zh-CN",
      patch: { languagePreference: "system", systemLanguage: "zh-CN" },
    });
    assert.equal(
      nextLanguageSettingsBackfill({
        localPreference: "system",
        detectedSystemLanguage: "zh-CN",
        settingsAvailable: true,
        mutationPending: false,
        lastAttemptKey: firstBackfill.attemptKey,
      }),
      undefined,
      "a failed automatic backfill must not retry forever",
    );
    assert.deepEqual(
      nextLanguageSettingsBackfill({
        hostPreference: "system",
        hostSystemLanguage: "en",
        localPreference: "system",
        detectedSystemLanguage: "zh-CN",
        settingsAvailable: true,
        mutationPending: false,
        lastAttemptKey: "",
      }),
      {
        attemptKey: ":zh-CN",
        patch: { systemLanguage: "zh-CN" },
      },
    );

    const pseudoTemplate = pseudoLocalizeTemplate("Hello {name}");
    assert.match(pseudoTemplate, /^\\[!! /);
    assert.match(pseudoTemplate, /{name}/);
    const pseudoMessage = translateInLanguage(
      "zh-CN",
      "conversation.deleteProjectConfirm",
      { title: "Alpha", count: 1 },
      { pseudo: true },
    );
    assert.match(pseudoMessage, /Alpha/);
    assert.doesNotMatch(pseudoMessage, /Åŀþħå/);

    function placeholders(value) {
      return [...value.matchAll(/\\{(\\w+)\\}/g)].map((match) => match[1]).sort();
    }
  `;
}
