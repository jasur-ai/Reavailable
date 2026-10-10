import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { splitTranscript } from '../../core/documents/splitText';
import { describeError } from '../../core/messages';
import { BOOK_LANGUAGES, VOICE_GENDERS, voiceFor, type BookLanguage, type VoiceGender } from '../../core/voices';
import { pickTranscriptFile, TranscriptFileError } from '../../platform/documents/transcriptFile';
import { Button, Card, Field, Notice, SectionTitle, Segmented } from '../components/common';
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
}

export function AddBookScreen({ onSubmit, onCancel }: AddBookScreenProps) {
  const t = useTranslate();
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [language, setLanguage] = useState<BookLanguage>('uz');
  const [gender, setGender] = useState<VoiceGender>('female');
  const [sentencesPerChunk, setSentencesPerChunk] = useState<1 | 2>(2);
  const [errors, setErrors] = useState<NewBookErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<{ message: string; detail: string | null } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const cyrillic = language === 'uz' && containsCyrillic(transcript);
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
        language,
        voice: voiceFor(language, gender),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('addBook.submitError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={typography.title}>{t('addBook.title')}</Text>
        <Text style={typography.small}>{t('addBook.sourceHint')}</Text>
      </View>

      <SectionTitle>1 · {t('addBook.titleLabel')}</SectionTitle>
      <Card>
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

      <SectionTitle>2 · {t('addBook.sectionText')}</SectionTitle>
      <Card>
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
        <Field
          label={t('addBook.textLabel')}
          value={transcript}
          onChangeText={setTranscript}
          error={errors.transcript}
          multiline
          minHeight={220}
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

      <SectionTitle>3 · {t('addBook.sectionVoice')}</SectionTitle>
      <Card>
        <Text style={styles.fieldLabel}>{t('addBook.languageLabel')}</Text>
        <Segmented<BookLanguage>
          label={t('addBook.languageLabel')}
          value={language}
          onChange={setLanguage}
          options={BOOK_LANGUAGES.map((value) => ({
            value,
            label: value === 'uz' ? t('addBook.languageUz') : t('addBook.languageEn'),
          }))}
        />
        <Text style={[styles.fieldLabel, styles.gap]}>{t('addBook.voiceLabel')}</Text>
        <Segmented<VoiceGender>
          label={t('addBook.voiceLabel')}
          value={gender}
          onChange={setGender}
          options={VOICE_GENDERS.map((value) => ({
            value,
            label: value === 'female' ? t('addBook.voiceFemale') : t('addBook.voiceMale'),
          }))}
        />
      </Card>

      <SectionTitle>4 · {t('addBook.sectionParts')}</SectionTitle>
      <Card>
        <Text style={typography.small}>{t('addBook.partLengthBody')}</Text>
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

      {submitError ? <Notice tone="danger">{submitError}</Notice> : null}

      <View style={styles.actions}>
        <Button label={t('addBook.create')} onPress={submit} busy={submitting} />
        <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} disabled={submitting} />
      </View>
      <Text style={styles.footnote}>{t('addBook.footnote')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl, backgroundColor: colors.background, flexGrow: 1 },
  header: { gap: spacing.xs, marginBottom: spacing.md },
  fieldLabel: { ...typography.small, fontWeight: '600', color: colors.text },
  gap: { marginTop: spacing.sm },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  footnote: { ...typography.small, textAlign: 'center', marginTop: spacing.sm },
});
