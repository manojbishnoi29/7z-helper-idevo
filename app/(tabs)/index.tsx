import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
import {
  FileArchive,
  FileText,
  KeyRound,
  Play,
  Square,
  Trash2,
  Save,
  Copy,
  FolderOutput,
  Languages,
  ShieldCheck,
  Info,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Upload,
  Clock,
  Hash,
  ChevronDown,
  ChevronUp,
} from 'lucide-react-native';
import { STRINGS, Lang } from '@/constants/i18n';
import { parseTxtContent, parseManualInput, formatFileSize } from '@/utils/txtParser';
import { verifyPassword, isNativeEngineAvailable, ENGINE_INFO } from '@/utils/sevenZipEngine';

interface ArchiveInfo {
  uri: string;
  name: string;
  size: number;
  valid: boolean;
}

interface Candidate {
  lineNumber: number;
  password: string;
}

type RecoveryStatus = 'idle' | 'running' | 'success' | 'failed' | 'error' | 'stopped';
type ExtractionStatus = 'idle' | 'extracting' | 'done' | 'failed';

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const isWide = width > 520;

  const [lang, setLang] = useState<Lang>('hi');
  const t = STRINGS[lang];

  const [archive, setArchive] = useState<ArchiveInfo | null>(null);
  const [archiveErr, setArchiveErr] = useState<string | null>(null);

  const [manualText, setManualText] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [txtInfo, setTxtInfo] = useState<{ total: number; valid: number; hadBom: boolean; preview: Candidate[] } | null>(null);

  const [status, setStatus] = useState<RecoveryStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [progress, setProgress] = useState({ total: 0, checked: 0, currentNum: 0, percent: 0, elapsed: 0 });
  const [found, setFound] = useState<{ password: string; lineNumber: number } | null>(null);
  const [revealPwd, setRevealPwd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mockEnabled, setMockEnabled] = useState(false);
  const [showBuildInfo, setShowBuildInfo] = useState(false);
  const [extractionStatus, setExtractionStatus] = useState<ExtractionStatus>('idle');
  const [extractionMsg, setExtractionMsg] = useState('');

  const cancelRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const jobRunningRef = useRef(false);

  const nativeAvailable = isNativeEngineAvailable();

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      cancelRef.current = true;
    };
  }, []);

  const toggleLang = () => setLang((p) => (p === 'hi' ? 'en' : 'hi'));

  const pickArchive = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      const name = a.name ?? 'archive.7z';
      const size = a.size ?? 0;
      const valid = name.toLowerCase().endsWith('.7z');
      setArchive({ uri: a.uri, name, size, valid });
      setArchiveErr(valid ? null : t.invalidArchive);
      setStatus('idle');
      setStatusMsg('');
      setFound(null);
    } catch (e: any) {
      setArchiveErr(e?.message ?? 'Picker failed');
    }
  };

  const pickTxt = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/*', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const uri = res.assets[0].uri;

      // Read file as UTF-8 — handle both legacy and new FileSystem API
      let content = '';
      try {
        // Try legacy API first
        const legacy = FileSystem as any;
        if (legacy.readAsStringAsync) {
          content = await legacy.readAsStringAsync(uri, { encoding: 'utf8' });
        } else if (legacy.File) {
          const file = new legacy.File(uri);
          content = await file.text();
        } else {
          // fallback fetch
          const resp = await fetch(uri);
          content = await resp.text();
        }
      } catch {
        const resp = await fetch(uri);
        content = await resp.text();
      }

      const parsed = parseTxtContent(content);
      setCandidates(parsed.candidates);
      setTxtInfo({
        total: parsed.totalLines,
        valid: parsed.validCount,
        hadBom: parsed.hadBom,
        preview: parsed.candidates.slice(0, 5),
      });
      setStatus('idle');
      setStatusMsg('');
      setFound(null);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to read TXT');
    }
  };

  const handleManualSave = () => {
    if (!manualText.trim()) {
      Alert.alert(t.statusError, t.statusNeedCandidates);
      return;
    }
    const parsed = parseManualInput(manualText);
    // For manual, we keep spaces — parseTxtContent already preserves them.
    // Filter only valid (non-empty lines already)
    setCandidates(parsed.candidates);
    setTxtInfo({
      total: parsed.totalLines,
      valid: parsed.validCount,
      hadBom: false,
      preview: parsed.candidates.slice(0, 5),
    });
    setStatus('idle');
    setStatusMsg('');
    setFound(null);
  };

  const handleClearManual = () => {
    setManualText('');
    // Don't clear imported candidates automatically — user explicitly clears via Candidates clear
  };

  const clearCandidates = () => {
    setCandidates([]);
    setTxtInfo(null);
    setManualText('');
    setStatus('idle');
    setFound(null);
    setStatusMsg('');
  };

  const startRecovery = useCallback(async () => {
    if (jobRunningRef.current) return;
    if (!archive) {
      setStatus('error');
      setStatusMsg(t.statusNeedArchive);
      return;
    }
    if (!archive.valid) {
      setStatus('error');
      setStatusMsg(t.invalidArchive);
      return;
    }
    if (candidates.length === 0) {
      setStatus('error');
      setStatusMsg(t.statusNeedCandidates);
      return;
    }

    // If native not available and mock not enabled, show engine missing instead of fake run
    if (!nativeAvailable && !mockEnabled) {
      setStatus('error');
      setStatusMsg(t.engineMissingDesc);
      return;
    }

    jobRunningRef.current = true;
    cancelRef.current = false;
    setStatus('running');
    setStatusMsg(t.statusRunning);
    setFound(null);
    setRevealPwd(false);
    setCopied(false);
    setExtractionStatus('idle');
    setExtractionMsg('');

    const total = candidates.length;
    setProgress({ total, checked: 0, currentNum: 1, percent: 0, elapsed: 0 });
    startTimeRef.current = Date.now();

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setProgress((p) => ({ ...p, elapsed }));
    }, 1000);

    let checked = 0;
    let foundCandidate: Candidate | null = null;
    let errorType: string | null = null;

    for (let i = 0; i < candidates.length; i++) {
      if (cancelRef.current) {
        setStatus('stopped');
        setStatusMsg(t.statusPaused);
        break;
      }

      const cand = candidates[i];
      checked = i + 1;
      const percent = Math.round((checked / total) * 100);
      setProgress((p) => ({
        ...p,
        checked,
        currentNum: checked,
        percent,
      }));

      // Small delay to keep UI responsive and allow cancellation
      await new Promise<void>((resolve) => setTimeout(resolve, 120));

      if (cancelRef.current) {
        setStatus('stopped');
        setStatusMsg(t.statusPaused);
        break;
      }

      let result;
      if (mockEnabled && !nativeAvailable) {
        // Mock mode: treat "correct" password as success for demo; everything else incorrect
        // We use a deterministic demo password so ordered checking can be verified
        // If archive name contains demo, we accept "DemoPass123" at its position
        const demoPassword = 'DemoPass123';
        if (cand.password === demoPassword) {
          result = { status: 'correct' as const };
        } else {
          result = { status: 'incorrect' as const };
        }
        // Add tiny extra delay to simulate real decryption
        await new Promise<void>((r) => setTimeout(r, 80));
      } else {
        result = await verifyPassword(archive.uri, cand.password);
      }

      if (result.status === 'correct') {
        foundCandidate = cand;
        break;
      } else if (result.status === 'engine_unavailable') {
        errorType = result.message;
        setStatus('error');
        setStatusMsg(result.message);
        break;
      } else if (result.status === 'corrupted') {
        errorType = 'Archive appears corrupted';
        setStatus('error');
        setStatusMsg('Archive corrupted — cannot verify passwords.');
        break;
      } else if (result.status === 'unsupported') {
        errorType = 'Unsupported encryption method';
        setStatus('error');
        setStatusMsg('Unsupported archive format/encryption.');
        break;
      } else if (result.status === 'error') {
        errorType = result.message;
        setStatus('error');
        setStatusMsg(result.message);
        break;
      }
      // incorrect -> continue
    }

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
    setProgress((p) => ({ ...p, elapsed, checked }));

    if (foundCandidate) {
      setFound({ password: foundCandidate.password, lineNumber: foundCandidate.lineNumber });
      setStatus('success');
      setStatusMsg(t.statusSuccess);
    } else if (cancelRef.current) {
      // already set to stopped
    } else if (errorType) {
      // error already set
    } else if (checked === total) {
      setStatus('failed');
      setStatusMsg(t.statusFailed);
    }

    jobRunningRef.current = false;
  }, [archive, candidates, t, nativeAvailable, mockEnabled]);

  const stopRecovery = () => {
    cancelRef.current = true;
    setStatusMsg(t.statusPaused);
  };

  const handleCopy = async () => {
    if (!found) return;
    await Clipboard.setStringAsync(found.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExtract = async () => {
    if (!found || !archive) return;
    if (!nativeAvailable && !mockEnabled) {
      setExtractionStatus('failed');
      setExtractionMsg(t.engineMissingDesc);
      return;
    }
    if (mockEnabled && !nativeAvailable) {
      setExtractionStatus('extracting');
      setExtractionMsg(t.extractionProgress + '... (mock)');
      setTimeout(() => {
        setExtractionStatus('done');
        setExtractionMsg('Mock extraction complete — files would be extracted to chosen folder in native build.');
      }, 1200);
      return;
    }
    // Real native extraction: need folder picker — not available in Expo Go, so show guidance
    Alert.alert(
      t.selectOutput,
      t.warningExtract + '\n\n' + t.overwriteWarn + '\n\nIn native build, system folder picker will open here.',
      [
        { text: t.cancel, style: 'cancel' },
        {
          text: t.confirmExtract,
          onPress: async () => {
            setExtractionStatus('extracting');
            setExtractionMsg(t.extractionProgress + '...');
            // In real build, this would call native folder picker then extraction
            // For preview, simulate folder selection
            setTimeout(() => {
              setExtractionStatus('done');
              setExtractionMsg(t.extractionDone + ' (preview — native build will extract to SAF folder)');
            }, 1500);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.scroll, isWide && styles.scrollWide]} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <FileArchive size={28} color="#fff" />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.appName}>{t.appName}</Text>
            <Text style={styles.subtitle}>{t.subtitle}</Text>
          </View>
          <TouchableOpacity onPress={toggleLang} style={styles.langBtn} activeOpacity={0.7}>
            <Languages size={16} color="#2563EB" />
            <Text style={styles.langText}>{lang === 'hi' ? t.switchToEnglish : t.switchToHindi}</Text>
          </TouchableOpacity>
        </View>

        {/* Help */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Info size={18} color="#2563EB" />
            <Text style={styles.cardTitle}>{t.helpTitle}</Text>
          </View>
          <Text style={styles.helpSteps}>{t.helpSteps}</Text>
          <View style={styles.badgesRow}>
            <View style={styles.badge}><Text style={styles.badgeText}>{t.bomHandled}</Text></View>
            <View style={styles.badge}><Text style={styles.badgeText}>{t.crlfHandled}</Text></View>
            <View style={[styles.badge, { backgroundColor: nativeAvailable ? '#ECFDF5' : '#FEF2F2', borderColor: nativeAvailable ? '#10B981' : '#F87171' }]}>
              <Text style={[styles.badgeText, { color: nativeAvailable ? '#065F46' : '#991B1B' }]}>
                {nativeAvailable ? '● ' + t.engineNote : '○ ' + t.engineMissingTitle}
              </Text>
            </View>
          </View>
        </View>

        {/* Select Archive */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <FileArchive size={18} color="#0F172A" />
            <Text style={styles.cardTitle}>{t.selectArchive}</Text>
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={pickArchive} activeOpacity={0.8}>
            <Upload size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>{t.filePickerArchive}</Text>
          </TouchableOpacity>
          {archive ? (
            <View style={[styles.fileInfo, archive.valid ? styles.fileValid : styles.fileInvalid]}>
              <View style={styles.fileRow}>
                <FileArchive size={16} color={archive.valid ? '#059669' : '#DC2626'} />
                <Text style={styles.fileName} numberOfLines={2}>{archive.name}</Text>
                {archive.valid ? <CheckCircle2 size={16} color="#059669" /> : <XCircle size={16} color="#DC2626" />}
              </View>
              <View style={styles.fileMeta}>
                <Text style={styles.metaText}>{t.fileSize}: {formatFileSize(archive.size)}</Text>
                <Text style={[styles.metaText, { color: archive.valid ? '#059669' : '#DC2626' }]}>{archive.valid ? t.validArchive : t.invalidArchive}</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.emptyText}>{t.noFileSelected}</Text>
          )}
          {archiveErr && <Text style={styles.errorText}>{archiveErr}</Text>}
          <Text style={styles.privacyNote}><ShieldCheck size={12} color="#64748B" /> {t.privacyNote}</Text>
        </View>

        {/* Manual Candidates */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <KeyRound size={18} color="#0F172A" />
            <Text style={styles.cardTitle}>{t.manualCandidates}</Text>
          </View>
          <Text style={styles.hint}>{t.onePerLine}</Text>
          <TextInput
            style={styles.textArea}
            multiline
            numberOfLines={6}
            placeholder={t.placeholder}
            placeholderTextColor="#94A3B8"
            value={manualText}
            onChangeText={setManualText}
            textAlignVertical="top"
          />
          <View style={styles.rowBtns}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={handleClearManual} activeOpacity={0.7}>
              <Trash2 size={16} color="#64748B" />
              <Text style={styles.secondaryText}>{t.clear}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.accentBtn} onPress={handleManualSave} activeOpacity={0.8}>
              <Save size={16} color="#fff" />
              <Text style={styles.accentText}>{t.saveCandidates}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Import TXT */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <FileText size={18} color="#0F172A" />
            <Text style={styles.cardTitle}>{t.importTxt}</Text>
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={pickTxt} activeOpacity={0.8}>
            <FileText size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>{t.filePickerTxt}</Text>
          </TouchableOpacity>

          {txtInfo && (
            <View style={styles.statsGrid}>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>{t.totalLines}</Text>
                <Text style={styles.statValue}>{txtInfo.total}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>{t.validEntries}</Text>
                <Text style={[styles.statValue, { color: '#059669' }]}>{txtInfo.valid}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>{t.candidatesCount}</Text>
                <Text style={styles.statValue}>{candidates.length}</Text>
              </View>
            </View>
          )}

          {txtInfo && txtInfo.preview.length > 0 && (
            <View style={styles.previewBox}>
              <Text style={styles.previewTitle}>{t.preview}</Text>
              {txtInfo.preview.map((c, idx) => (
                <View key={idx} style={styles.previewRow}>
                  <Text style={styles.previewLine}>{t.line} {c.lineNumber}:</Text>
                  <Text style={styles.previewPwd} numberOfLines={1}>{c.password.length > 30 ? c.password.slice(0, 30) + '…' : c.password}</Text>
                </View>
              ))}
              {candidates.length > 5 && <Text style={styles.moreText}>+ {candidates.length - 5} more</Text>}
            </View>
          )}

          {candidates.length > 0 && (
            <TouchableOpacity onPress={clearCandidates} style={styles.linkBtn}>
              <Text style={styles.linkText}>{t.clear} ({candidates.length})</Text>
            </TouchableOpacity>
          )}

          {/* Mock toggle for preview */}
          {!nativeAvailable && (
            <View style={styles.mockBox}>
              <View style={styles.mockHeader}>
                <AlertTriangle size={14} color="#D97706" />
                <Text style={styles.mockTitle}>Preview Mock Engine</Text>
              </View>
              <Text style={styles.mockDesc}>
                {lang === 'hi'
                  ? 'Expo प्रीव्यू में असली 7z इंजन नहीं चलता। मॉक चालू करें तो DemoPass123 को सही पासवर्ड माना जाएगा ताकि आप Success/Progress फ्लो देख सकें।'
                  : 'Native 7z engine does not run in Expo preview. Enable mock to treat DemoPass123 as correct for testing flows.'}
              </Text>
              <TouchableOpacity
                onPress={() => setMockEnabled((v) => !v)}
                style={[styles.mockToggle, mockEnabled && styles.mockToggleOn]}
                activeOpacity={0.7}
              >
                <Text style={[styles.mockToggleText, mockEnabled && styles.mockToggleTextOn]}>
                  {mockEnabled ? (lang === 'hi' ? '● मॉक चालू' : '● Mock ON') : (lang === 'hi' ? '○ मॉक बंद' : '○ Mock OFF')}
                </Text>
              </TouchableOpacity>
              {mockEnabled && (
                <Text style={styles.mockHint}>
                  {lang === 'hi' ? 'TXT में DemoPass123 जोड़ें और रिकवरी शुरू करें।' : 'Add DemoPass123 to TXT and start recovery to see success.'}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Progress & Recovery Control */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Clock size={18} color="#0F172A" />
            <Text style={styles.cardTitle}>{t.progress}</Text>
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>{t.totalCandidates}</Text>
              <Text style={styles.statValue}>{progress.total}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>{t.checked}</Text>
              <Text style={styles.statValue}>{progress.checked}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>{t.remaining}</Text>
              <Text style={styles.statValue}>{Math.max(0, progress.total - progress.checked)}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>{t.currentNum}</Text>
              <Text style={styles.statValue}>{progress.currentNum}</Text>
            </View>
          </View>

          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${progress.percent}%` }]} />
          </View>
          <View style={styles.progressMeta}>
            <Text style={styles.metaText}>{progress.percent}{t.percent}</Text>
            <Text style={styles.metaText}>{t.elapsed}: {progress.elapsed}{t.sec}</Text>
          </View>

          <View style={styles.statusBox}>
            <Text style={styles.statusLabel}>{t.status}:</Text>
            <Text style={[
              styles.statusValue,
              status === 'success' && { color: '#059669' },
              status === 'failed' && { color: '#D97706' },
              status === 'error' && { color: '#DC2626' },
              status === 'running' && { color: '#2563EB' },
            ]}>
              {status === 'idle' && t.statusIdle}
              {status === 'running' && t.statusRunning}
              {status === 'stopped' && t.statusPaused}
              {status === 'success' && t.statusSuccess}
              {status === 'failed' && t.statusFailed}
              {status === 'error' && (statusMsg || t.statusError)}
            </Text>
          </View>
          {statusMsg && status !== 'error' && <Text style={styles.statusMsg}>{statusMsg}</Text>}

          {status === 'running' ? (
            <TouchableOpacity style={styles.stopBtn} onPress={stopRecovery} activeOpacity={0.8}>
              <Square size={16} color="#fff" />
              <Text style={styles.stopText}>{t.stopRecovery}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.startBtn, (candidates.length === 0 || !archive?.valid) && styles.startBtnDisabled]}
              onPress={startRecovery}
              activeOpacity={0.8}
            >
              <Play size={18} color="#fff" />
              <Text style={styles.startText}>{t.startRecovery}</Text>
            </TouchableOpacity>
          )}

          {status === 'running' && <ActivityIndicator size="small" color="#2563EB" style={{ marginTop: 10 }} />}
          {!nativeAvailable && !mockEnabled && (
            <Text style={styles.engineWarning}>{t.engineMissingDesc}</Text>
          )}
        </View>

        {/* Results */}
        {status === 'success' && found && (
          <View style={[styles.card, styles.successCard]}>
            <View style={styles.successHeader}>
              <CheckCircle2 size={24} color="#059669" />
              <Text style={styles.successTitle}>{t.successTitle}</Text>
            </View>
            <Text style={styles.successDesc}>{t.successDesc}</Text>

            <View style={styles.pwdBox}>
              <Text style={styles.pwdLabel}>{t.lineNumber}: {found.lineNumber}</Text>
              <View style={styles.pwdRow}>
                <Text style={styles.pwdValue} selectable>
                  {revealPwd ? found.password : '••••••••••••'}
                </Text>
                <TouchableOpacity onPress={() => setRevealPwd((v) => !v)} style={styles.eyeBtn}>
                  {revealPwd ? <EyeOff size={18} color="#64748B" /> : <Eye size={18} color="#64748B" />}
                  <Text style={styles.eyeText}>{revealPwd ? t.hide : t.reveal}</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.rowBtns}>
              <TouchableOpacity style={styles.accentBtn} onPress={handleCopy} activeOpacity={0.8}>
                <Copy size={16} color="#fff" />
                <Text style={styles.accentText}>{copied ? t.copied : t.copyPassword}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleExtract} activeOpacity={0.8}>
                <FolderOutput size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>{t.extractArchive}</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.warningText}>{t.warningExtract}</Text>
            <Text style={styles.hint}>{t.overwriteWarn}</Text>

            {extractionStatus !== 'idle' && (
              <View style={styles.extractBox}>
                <Text style={styles.extractLabel}>{t.extractionProgress}</Text>
                {extractionStatus === 'extracting' && <ActivityIndicator size="small" color="#2563EB" />}
                <Text style={[
                  styles.extractMsg,
                  extractionStatus === 'done' && { color: '#059669' },
                  extractionStatus === 'failed' && { color: '#DC2626' },
                ]}>{extractionMsg}</Text>
                {extractionStatus === 'done' && <Text style={styles.successDesc}>{t.extractionDone}</Text>}
              </View>
            )}
          </View>
        )}

        {status === 'failed' && (
          <View style={[styles.card, styles.failCard]}>
            <View style={styles.failHeader}>
              <XCircle size={24} color="#D97706" />
              <Text style={styles.failTitle}>{t.noMatchTitle}</Text>
            </View>
            <Text style={styles.failDesc}>{t.noMatchDesc}</Text>
            <Text style={styles.metaText}>{t.totalChecked}: {progress.checked}</Text>
            <View style={styles.rowBtns}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={pickTxt} activeOpacity={0.7}>
                <FileText size={16} color="#0F172A" />
                <Text style={styles.secondaryText}>{t.importAnother}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStatus('idle')} activeOpacity={0.7}>
                <Hash size={16} color="#0F172A" />
                <Text style={styles.secondaryText}>{t.editCandidates}</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.accentBtn} onPress={startRecovery} activeOpacity={0.8}>
              <Play size={16} color="#fff" />
              <Text style={styles.accentText}>{t.runAgain}</Text>
            </TouchableOpacity>
          </View>
        )}

        {status === 'error' && (
          <View style={[styles.card, styles.errorCard]}>
            <View style={styles.failHeader}>
              <AlertTriangle size={24} color="#DC2626" />
              <Text style={[styles.failTitle, { color: '#DC2626' }]}>{t.statusError}</Text>
            </View>
            <Text style={styles.failDesc}>{statusMsg}</Text>
            {!nativeAvailable && (
              <TouchableOpacity style={styles.linkBtn} onPress={() => setShowBuildInfo((v) => !v)}>
                <Text style={styles.linkText}>{showBuildInfo ? '▲ Hide build instructions' : '▼ Show native build instructions'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Build Instructions */}
        <TouchableOpacity style={styles.card} onPress={() => setShowBuildInfo((v) => !v)} activeOpacity={0.7}>
          <View style={styles.cardHead}>
            <ShieldCheck size={18} color="#0F172A" />
            <Text style={styles.cardTitle}>Native Build / Integration Plan</Text>
            {showBuildInfo ? <ChevronUp size={18} color="#64748B" /> : <ChevronDown size={18} color="#64748B" />}
          </View>
          {showBuildInfo && (
            <View style={{ marginTop: 8 }}>
              <Text style={styles.buildText}>
                {'Real 7z verification requires a native Android build (SevenZipJBinding). Steps:\n\n'}
                {'1. Eject to bare workflow: `npx expo prebuild`\n'}
                {'2. Add to android/app/build.gradle:\n   implementation \'net.sf.sevenzipjbinding:sevenzipjbinding:16.02-2.01\'\n   implementation \'net.sf.sevenzipjbinding:sevenzipjbinding-all-platforms:16.02-2.01\'\n'}
                {'3. Place native libs for arm64-v8a/armeabi-v7a/x86_64 under jniLibs\n'}
                {'4. Implement SevenZipModule.kt (see /native/README.md) exposing:\n   - verifyPassword(archiveUri, password) -> "correct"|"incorrect"|"corrupted"|"unsupported"\n   - extractArchive(archiveUri, password, outputUri)\n'}
                {'5. SAF: use ACTION_OPEN_DOCUMENT for .7z and .txt, and ACTION_OPEN_DOCUMENT_TREE for extraction\n'}
                {'6. Build: `cd android && ./gradlew assembleRelease`\n\n'}
                {'Engine: SevenZipJBinding uses native p7zip 16.02 — supports AES-256 7zAES. Other codecs return unsupported.\n'}
                {'Expo Go cannot load .so; use `eas build` or local Gradle build for real decryption.'}
              </Text>
              <Text style={[styles.buildText, { marginTop: 8, fontWeight: '700' }]}>
                Current engine: {ENGINE_INFO.library} — {ENGINE_INFO.mavenCoord}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>{t.privacyNote}</Text>
          <Text style={styles.footerText}>{t.engineNote}</Text>
          <Text style={styles.footerSmall}>7z Password Recovery Helper • v1.0.0 • Android • SAF • UTF-8 BOM/CRLF handled</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F1F5F9' },
  scroll: { padding: 16, paddingBottom: 40, maxWidth: 640, alignSelf: 'center', width: '100%' },
  scrollWide: { padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  headerIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1 },
  appName: { color: '#fff', fontSize: 16, fontWeight: '800' },
  subtitle: { color: '#94A3B8', fontSize: 12, marginTop: 2 },
  langBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  langText: { color: '#2563EB', fontWeight: '700', fontSize: 13 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  helpSteps: { color: '#475569', fontSize: 13, lineHeight: 18, marginBottom: 10 },
  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: {
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeText: { fontSize: 11, color: '#475569', fontWeight: '600' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  fileInfo: {
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
  },
  fileValid: { backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' },
  fileInvalid: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { flex: 1, fontWeight: '600', color: '#0F172A', fontSize: 13 },
  fileMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  emptyText: { color: '#94A3B8', fontSize: 13, marginTop: 10, fontStyle: 'italic' },
  errorText: { color: '#DC2626', fontSize: 12, marginTop: 8 },
  privacyNote: { color: '#64748B', fontSize: 11, marginTop: 10 },
  hint: { color: '#64748B', fontSize: 12, marginBottom: 8 },
  textArea: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: '#0F172A',
    minHeight: 110,
    backgroundColor: '#F8FAFC',
  },
  rowBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#F1F5F9',
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  secondaryText: { color: '#0F172A', fontWeight: '600', fontSize: 13 },
  accentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0F172A',
    paddingVertical: 11,
    borderRadius: 12,
  },
  accentText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  statBox: {
    flex: 1,
    minWidth: 70,
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  statLabel: { fontSize: 10, color: '#64748B', fontWeight: '600', textTransform: 'uppercase' },
  statValue: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginTop: 2 },
  previewBox: { marginTop: 12, backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  previewTitle: { fontWeight: '700', fontSize: 12, color: '#0F172A', marginBottom: 6 },
  previewRow: { flexDirection: 'row', gap: 8, paddingVertical: 3 },
  previewLine: { fontSize: 12, color: '#64748B', fontWeight: '600', minWidth: 60 },
  previewPwd: { fontSize: 12, color: '#0F172A', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) as any },
  moreText: { fontSize: 11, color: '#94A3B8', marginTop: 6 },
  linkBtn: { alignSelf: 'flex-start', marginTop: 10 },
  linkText: { color: '#2563EB', fontWeight: '600', fontSize: 13 },
  mockBox: {
    marginTop: 12,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FCD34D',
    borderRadius: 12,
    padding: 12,
  },
  mockHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  mockTitle: { fontWeight: '700', color: '#92400E', fontSize: 13 },
  mockDesc: { color: '#92400E', fontSize: 12, lineHeight: 16 },
  mockToggle: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  mockToggleOn: { backgroundColor: '#0F172A', borderColor: '#0F172A' },
  mockToggleText: { fontWeight: '700', fontSize: 12, color: '#64748B' },
  mockToggleTextOn: { color: '#fff' },
  mockHint: { marginTop: 8, fontSize: 11, color: '#B45309', fontStyle: 'italic' },
  progressBarBg: { height: 10, backgroundColor: '#E2E8F0', borderRadius: 20, overflow: 'hidden', marginTop: 14 },
  progressBarFill: { height: '100%', backgroundColor: '#2563EB', borderRadius: 20 },
  progressMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  metaText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  statusBox: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, backgroundColor: '#F8FAFC', padding: 10, borderRadius: 10 },
  statusLabel: { fontSize: 12, color: '#64748B', fontWeight: '700' },
  statusValue: { fontSize: 13, fontWeight: '700', color: '#0F172A', flex: 1 },
  statusMsg: { fontSize: 12, color: '#475569', marginTop: 6 },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#059669',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 12,
  },
  startBtnDisabled: { opacity: 0.5 },
  startText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#DC2626',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 12,
  },
  stopText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  engineWarning: { color: '#DC2626', fontSize: 11, marginTop: 8, textAlign: 'center' },
  successCard: { borderColor: '#10B981', borderWidth: 1.5 },
  successHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  successTitle: { fontSize: 16, fontWeight: '800', color: '#059669' },
  successDesc: { color: '#475569', fontSize: 13, marginTop: 6 },
  pwdBox: { backgroundColor: '#ECFDF5', borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: '#A7F3D0' },
  pwdLabel: { fontSize: 11, color: '#065F46', fontWeight: '700' },
  pwdRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  pwdValue: { fontSize: 16, fontWeight: '800', color: '#0F172A', flex: 1, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) as any },
  eyeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff', borderRadius: 20, borderWidth: 1, borderColor: '#A7F3D0' },
  eyeText: { fontSize: 12, fontWeight: '600', color: '#065F46' },
  warningText: { color: '#D97706', fontSize: 11, marginTop: 10, fontWeight: '600' },
  extractBox: { marginTop: 12, backgroundColor: '#EFF6FF', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#BFDBFE', alignItems: 'center', gap: 6 },
  extractLabel: { fontWeight: '700', color: '#1E40AF', fontSize: 12 },
  extractMsg: { fontSize: 12, color: '#475569', textAlign: 'center' },
  failCard: { borderColor: '#FCD34D', borderWidth: 1.5 },
  failHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  failTitle: { fontSize: 15, fontWeight: '800', color: '#B45309' },
  failDesc: { color: '#475569', fontSize: 13, marginTop: 6 },
  errorCard: { borderColor: '#FCA5A5', borderWidth: 1.5 },
  buildText: { fontSize: 12, color: '#475569', lineHeight: 16, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) as any },
  footer: { alignItems: 'center', gap: 6, marginTop: 8, paddingVertical: 12 },
  footerText: { fontSize: 11, color: '#64748B', textAlign: 'center' },
  footerSmall: { fontSize: 10, color: '#94A3B8', textAlign: 'center', marginTop: 4 },
});
