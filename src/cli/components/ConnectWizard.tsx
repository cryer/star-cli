import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import {
  type ConnectAnswers,
  PROTOCOLS,
  PROTOCOL_DESCRIPTIONS,
  PROVIDER_PRESETS,
  type Protocol,
  type ProviderPreset,
  apiKeyEnvFor,
  dedupeName,
  deriveProviderName,
  maskApiKey,
} from "../commands/connect";
import { type SelectOption, SelectPrompt } from "./SelectPrompt";
import { TextField } from "./TextField";

type Step =
  | "provider"
  | "protocol"
  | "baseUrl"
  | "apiKey"
  | "model"
  | "confirm"
  | "setDefault"
  | "openFile";

interface ConnectWizardProps {
  existingProviderNames: string[];
  existingModelNames: string[];
  // Persists the provider/model and returns the user-facing result line.
  onSave(answers: ConnectAnswers): Promise<string>;
  onSetDefault(modelName: string): Promise<string>;
  onOpenConfig(): string;
  onFinish(message: string): void;
  onCancel(): void;
}

function YN({ question, onAnswer }: { question: string; onAnswer(yes: boolean): void }) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") onAnswer(true);
    else if (ch === "n" || key.escape) onAnswer(false);
  });
  return (
    <Text>
      {question} <Text dimColor>[y] yes [n] no</Text>
    </Text>
  );
}

export function ConnectWizard({
  existingProviderNames,
  existingModelNames,
  onSave,
  onSetDefault,
  onOpenConfig,
  onFinish,
  onCancel,
}: ConnectWizardProps) {
  const [step, setStep] = useState<Step>("provider");
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [protocol, setProtocol] = useState<Protocol>("openai-compatible");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [answers, setAnswers] = useState<ConnectAnswers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const busyRef = useRef(false);
  const notesRef = useRef<string[]>([]);

  const pushNote = (note: string) => {
    notesRef.current = [...notesRef.current, note];
    setNotes(notesRef.current);
  };

  const providerOptions: SelectOption[] = [
    ...PROVIDER_PRESETS.map((p) => ({ value: p.key, label: p.label, description: p.baseURL })),
    {
      value: "custom",
      label: "Custom",
      description: "relay or any OpenAI/Anthropic-compatible endpoint",
    },
  ];

  const handleProviderSelect = (value: string) => {
    const found = PROVIDER_PRESETS.find((p) => p.key === value) ?? null;
    setPreset(found);
    if (found) {
      setProtocol(found.protocol);
      setBaseURL(found.baseURL);
      setStep("baseUrl");
    } else {
      setStep("protocol");
    }
  };

  const handleProtocolSelect = (value: string) => {
    setProtocol(value as Protocol);
    setStep("baseUrl");
  };

  const submitBaseURL = (value: string) => {
    if (!value) {
      setError("baseURL is required");
      return;
    }
    setError(null);
    setBaseURL(value);
    setStep("apiKey");
  };

  const submitApiKey = (value: string) => {
    if (!value) {
      setError("API key is required");
      return;
    }
    setError(null);
    setApiKey(value);
    setStep("model");
  };

  const submitModel = (value: string) => {
    if (!value) {
      setError("model id is required");
      return;
    }
    setError(null);
    setModelId(value);
    const providerName = dedupeName(deriveProviderName(baseURL), existingProviderNames);
    setAnswers({
      providerName,
      protocol,
      baseURL,
      apiKeyEnv: apiKeyEnvFor(providerName),
      apiKey,
      modelName: dedupeName(value, existingModelNames),
      modelId: value,
    });
    setStep("confirm");
  };

  const handleConfirm = async (yes: boolean) => {
    if (!yes) {
      onCancel();
      return;
    }
    if (busyRef.current || !answers) return;
    busyRef.current = true;
    setBusy(true);
    try {
      pushNote(await onSave(answers));
    } catch (saveError) {
      busyRef.current = false;
      setBusy(false);
      setError(
        `Save failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
      );
      return;
    }
    busyRef.current = false;
    setBusy(false);
    setStep("setDefault");
  };

  const handleSetDefault = async (yes: boolean) => {
    if (busyRef.current || !answers) return;
    busyRef.current = true;
    setBusy(true);
    try {
      pushNote(yes ? await onSetDefault(answers.modelName) : "Default model unchanged.");
    } catch (setDefaultError) {
      pushNote(
        `Could not set the default model: ${setDefaultError instanceof Error ? setDefaultError.message : String(setDefaultError)}`,
      );
    }
    busyRef.current = false;
    setBusy(false);
    setStep("openFile");
  };

  const handleOpenFile = (yes: boolean) => {
    if (yes) pushNote(onOpenConfig());
    onFinish(notesRef.current.join("\n"));
  };

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Connect a provider
      </Text>
      {notes.map((note, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only
        <Text key={index} dimColor>
          {note}
        </Text>
      ))}
      {step === "provider" && (
        <SelectPrompt
          title="Which provider?"
          options={providerOptions}
          onSelect={handleProviderSelect}
          onCancel={onCancel}
        />
      )}
      {step === "protocol" && (
        <SelectPrompt
          title="API format (protocol)?"
          options={PROTOCOLS.map((p) => ({
            value: p,
            label: p,
            description: PROTOCOL_DESCRIPTIONS[p],
          }))}
          onSelect={handleProtocolSelect}
          onCancel={onCancel}
        />
      )}
      {step === "baseUrl" && (
        <TextField
          label="baseURL:"
          initialValue={preset?.baseURL ?? ""}
          placeholder="https://api.example.com/v1"
          onSubmit={submitBaseURL}
          onCancel={onCancel}
        />
      )}
      {step === "apiKey" && (
        <TextField
          label="API key:"
          masked
          placeholder="paste your key (hidden)"
          onSubmit={submitApiKey}
          onCancel={onCancel}
        />
      )}
      {step === "model" && (
        <TextField
          label="Model id:"
          placeholder={preset?.modelHint ?? "e.g. gpt-4o"}
          onSubmit={submitModel}
          onCancel={onCancel}
        />
      )}
      {step === "confirm" && answers && (
        <Box flexDirection="column">
          <Text>{`  provider:  ${answers.providerName} (${answers.protocol})`}</Text>
          <Text>{`  baseURL:   ${answers.baseURL}`}</Text>
          <Text>{`  API key:   ${maskApiKey(answers.apiKey)} → ${answers.apiKeyEnv} (stored in ~/.star-cli/.env)`}</Text>
          <Text>{`  model:     ${answers.modelName} → ${answers.modelId}`}</Text>
          {busy ? (
            <Text dimColor>Saving…</Text>
          ) : (
            <YN question="Save this provider and model?" onAnswer={handleConfirm} />
          )}
        </Box>
      )}
      {step === "setDefault" &&
        (busy ? (
          <Text dimColor>Saving…</Text>
        ) : (
          <YN
            question={`Set "${answers?.modelName}" as the default model and switch to it?`}
            onAnswer={handleSetDefault}
          />
        ))}
      {step === "openFile" && <YN question="Open the config file now?" onAnswer={handleOpenFile} />}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
