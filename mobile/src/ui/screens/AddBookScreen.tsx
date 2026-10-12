import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { splitTranscript } from '../../core/documents/splitText';
import { describeError } from '../../core/messages';
import { BOOK_LANGUAGES, VOICE_CATALOG, VOICE_GENDERS, voiceFor, type BookLanguage, type VoiceGender } from '../../core/voices';
import { pickTranscriptFile, TranscriptFileError } from '../../platform/documents/transcriptFile';
import { Button, Card, Field, Notice, Segmented } from '../components/common';
import {
  containsCyrillic,
  formatCount,
  MAX_TITLE_CHARS,
  MAX_TRANSCRIPT_CHARS,
  PART_MAX_CHARS,
  validateNewBook,
  type NewBookErrors,
} from '../presentation';
import { colors, spacing, typography } from '../theme';
import { useTranslate } from '../TranslateContext';

export interface NewBookInput {
  title: string;
  transcript: string;
  sentencesPerChunk: 1 | 2;
  language: BookLanguage;
  /** Azure voice id for the chosen language and gender. Null lets the server pick its default. */
  voice: string | null;
}

export interface AddBookScreenProps {
  onSubmit: (input: NewBookInput) => Promise<void>;
  onCancel: () => void;
  /** Voice ids the server offers. Null while unknown: then every option is shown. */
  serverVoices: readonly string[] | null;
}

/** Languages and genders that have a voice on this server. */
function availableOptions(serverVoices: readonly string[] | null) {
  const offered = (language: BookLanguage, gender?: VoiceGender) =>
    VOICE_CATALOG.some(
      (voice) =>
        voice.language === language &&
        (gender === undefined || voice.gender === gender) &&
        (serverVoices === null || serverVoices.includes(voice.id)),
    );
  return {
    languages: BOOK_LANGUAGES.filter((language) => offered(language)),
    genders: (language: BookLanguage) => VOICE_GENDERS.filter((gender) => offered(language, gender)),
  };
}

/**
 * Layout, top to bottom: title, the text (it takes all the free height and scrolls inside itself),
 * compact options, and a footer with the create button, which is always visible without scrolling.
 */
export function AddBookScreen({ onSubmit, onCancel, serverVoices }: AddBookScreenProps) {
  const t = useTranslate();
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [language, setLanguage] = useState<BookLanguage>('uz');
  const [gender, setGender] = useState<VoiceGender>('female');
  const options = useMemo(() => availableOptions(serverVoices), [serverVoices]);
  const genderOptions = options.genders(language);
  // Keep the selection valid when the server offers fewer voices than the app knows about.
  const effectiveLanguage = options.languages.includes(language) ? language : (options.languages[0] ?? language);
  const effectiveGender = genderOptions.includes(gender) ? gender : (genderOptions[0] ?? gender);
  const [sentencesPerChunk, setSentencesPerChunk] = useState<1 | 2>(2);
  const [errors, setErrors] = useState<NewBookErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<{ message: string; detail: string | null } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const cyrillic = effectiveLanguage === 'uz' && containsCyrillic(transcript);
  const parts = useMemo(
    () => (transcript.length > PART_MAX_CHARS ? splitTranscript(transcript, PART_MAX_CHARS).length : 1),
    [transcript],
  );

  const loadFile = async () => {
    setFileError(null);
    setLoadingFile(true);
    try {
      const picked = await pickTranscriptFile();
      if (picked) {
        setTranscript(picked.text);
        if (title.trim().length === 0) {
          setTitle(picked.name.slice(0, MAX_TITLE_CHARS));
        }
      }
    } catch (error) {
      if (error instanceof TranscriptFileError) {
        setFileError({ message: describeError(error.code, t), detail: error.message });
      } else {
        setFileError({ message: t('addBook.fileError'), detail: error instanceof Error ? error.message : null });
      }
    } finally {
      setLoadingFile(false);
    }
  };

  const submit = async () => {
    setSubmitError(null);
    const validation = validateNewBook({ title, transcript }, t);
    setErrors(validation);
    if (validation.title || validation.transcript) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        transcript: transcript.trim(),
        sentencesPerChunk,
        language: effectiveLanguage,
        voice: voiceFor(effectiveLanguage, effectiveGender),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('addBook.submitError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={typography.title}>{t('addBook.title')}</Text>
        <Text style={typography.small}>{t('addBook.sourceHint')}</Text>
      </View>

      <Card style={styles.titleCard}>
        <Field
          label={t('addBook.titleLabel')}
          value={title}
          onChangeText={setTitle}
          error={errors.title}
          maxLength={MAX_TITLE_CHARS}
          placeholder={t('addBook.titlePlaceholder')}
          autoCapitalize="sentences"
        />
      </Card>

      <Card style={styles.textCard}>
        <View style={styles.textTop}>
          <Button
            label={t('addBook.loadFile')}
            variant="secondary"
            onPress={loadFile}
            busy={loadingFile}
            accessibilityHint={t('addBook.loadFileHint')}
          />
          {fileError ? (
            <Notice tone="danger">
              {fileError.message}
              {fileError.detail ? `\n${t('addBook.detailPrefix')}: ${fileError.detail}` : ''}
            </Notice>
          ) : null}
        </View>
        <Field
          fill
          label={t('addBook.textLabel')}
          value={transcript}
          onChangeText={setTranscript}
          error={errors.transcript}
          multiline
          placeholder={t('addBook.textPlaceholder')}
          autoCapitalize="sentences"
          autoCorrect={false}
          hint={t('addBook.charCount', {
            count: formatCount(transcript.length),
            max: formatCount(MAX_TRANSCRIPT_CHARS),
          })}
        />
        {parts > 1 ? <Notice tone="info">{t('addBook.longTextHint', { parts })}</Notice> : null}
        {cyrillic ? <Notice tone="warning">{t('addBook.cyrillicWarning')}</Notice> : null}
      </Card>

      <ScrollView style={styles.optionsScroll} contentContainerStyle={styles.optionsContent}>
        <Card style={styles.optionsCard}>
          <Segmented<BookLanguage>
            label={t('addBook.languageLabel')}
            value={effectiveLanguage}
            onChange={setLanguage}
            options={options.languages.map((value) => ({
              value,
              label: value === 'uz' ? t('addBook.languageUz') : t('addBook.languageEn'),
            }))}
          />
          <Segmented<VoiceGender>
            label={t('addBook.voiceLabel')}
            value={effectiveGender}
            onChange={setGender}
            options={genderOptions.map((value) => ({
              value,
              label: value === 'female' ? t('addBook.voiceFemale') : t('addBook.voiceMale'),
            }))}
          />
          <Segmented
            label={t('addBook.sentencesLabel')}
            value={sentencesPerChunk}
            onChange={setSentencesPerChunk}
            options={[
              { value: 1, label: t('addBook.oneSentence') },
              { value: 2, label: t('addBook.twoSentences') },
            ]}
          />
        </Card>
      </ScrollView>

      {submitError ? <Notice tone="danger">{submitError}</Notice> : null}

      <View style={styles.footer}>
        <View style={styles.primary}>
          <Button label={t('addBook.create')} onPress={submit} busy={submitting} />
        </View>
        <View style={styles.secondary}>
          <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} disabled={submitting} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.background },
  header: { gap: spacing.xs },
  titleCard: { paddingVertical: spacing.sm },
  textCard: { flex: 1, gap: spacing.sm, minHeight: 0 },
  textTop: { gap: spacing.sm },
  optionsScroll: { maxHeight: 230, flexGrow: 0 },
  optionsContent: { flexGrow: 0 },
  optionsCard: { gap: spacing.sm, paddingVertical: spacing.sm },
  footer: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  primary: { flex: 2 },
  secondary: { flex: 1 },
});
