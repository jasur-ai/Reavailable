import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { pickTranscriptFile, TranscriptFileError } from '../../platform/documents/transcriptFile';
import { Button, Card, Field, Notice, Segmented } from '../components/common';
import {
  containsCyrillic,
  formatCount,
  MAX_TITLE_CHARS,
  MAX_TRANSCRIPT_CHARS,
  validateNewBook,
  type NewBookErrors,
} from '../presentation';
import { colors, spacing, typography } from '../theme';

export interface AddBookScreenProps {
  onSubmit: (input: { title: string; transcript: string; sentencesPerChunk: 1 | 2 }) => Promise<void>;
  onCancel: () => void;
}

export function AddBookScreen({ onSubmit, onCancel }: AddBookScreenProps) {
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [sentencesPerChunk, setSentencesPerChunk] = useState<1 | 2>(2);
  const [errors, setErrors] = useState<NewBookErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const cyrillic = containsCyrillic(transcript);

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
      setFileError(error instanceof TranscriptFileError ? error.message : 'The file could not be read.');
    } finally {
      setLoadingFile(false);
    }
  };

  const submit = async () => {
    setSubmitError(null);
    const validation = validateNewBook({ title, transcript });
    setErrors(validation);
    if (validation.title || validation.transcript) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ title: title.trim(), transcript: transcript.trim(), sentencesPerChunk });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The book could not be created.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={typography.title}>Add a book</Text>

      <Notice tone="info">
        Paste Uzbek text (Latin script works best) or load a .txt or .md file. The text is sent to the server only to
        create audio. The server deletes its copy as soon as this phone has downloaded and confirmed every part.
      </Notice>

      <Card>
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          error={errors.title}
          maxLength={MAX_TITLE_CHARS}
          placeholder="For example: Chapter 1"
          autoCapitalize="sentences"
        />
        <Field
          label="Text"
          value={transcript}
          onChangeText={setTranscript}
          error={errors.transcript}
          multiline
          minHeight={220}
          placeholder="Paste the text here"
          autoCapitalize="sentences"
          autoCorrect={false}
          hint={`${formatCount(transcript.length)} / ${formatCount(MAX_TRANSCRIPT_CHARS)} characters`}
        />
        {cyrillic ? (
          <Notice tone="warning">
            This text contains Cyrillic letters. The Uzbek voices are set up for Latin script, so some words may be
            pronounced incorrectly.
          </Notice>
        ) : null}
        <Button
          label="Load a .txt or .md file"
          variant="secondary"
          onPress={loadFile}
          busy={loadingFile}
          accessibilityHint="Opens the file picker"
        />
        {fileError ? <Text style={styles.error}>{fileError}</Text> : null}
      </Card>

      <Card>
        <Text style={typography.heading}>Part length</Text>
        <Text style={typography.small}>
          Each part is one or two sentences. Shorter parts start sooner; longer parts feel more natural.
        </Text>
        <Segmented
          label="Sentences per part"
          value={sentencesPerChunk}
          onChange={setSentencesPerChunk}
          options={[
            { value: 1, label: '1 sentence' },
            { value: 2, label: '2 sentences' },
          ]}
        />
      </Card>

      {submitError ? <Notice tone="danger">{submitError}</Notice> : null}

      <View style={styles.actions}>
        <Button label="Create audiobook" onPress={submit} busy={submitting} />
        <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={submitting} />
      </View>
      <Text style={styles.footnote}>
        Creating a book needs an internet connection. After the audio is on this phone, listening works offline.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
  error: { ...typography.small, color: colors.danger },
  actions: { gap: spacing.sm },
  footnote: { ...typography.small, textAlign: 'center' },
});
