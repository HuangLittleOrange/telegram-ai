import type { FC } from '../../../lib/teact/teact';
import type React from '../../../lib/teact/teact';
import {
  memo,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';

import InputText from '../../ui/InputText';

type SupportedAiProvider = 'openai' | 'anthropic' | 'gemini';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  provider: SupportedAiProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  defaultContextLimit: number;
};

const SettingsAi: FC<OwnProps & StateProps> = ({
  isActive,
  provider,
  model,
  apiKey,
  baseUrl,
  defaultContextLimit,
  onReset,
}) => {
  const {
    setSettingOption,
  } = getActions();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const updateAiSettings = useLastCallback((update: Partial<StateProps>) => {
    setSettingOption({
      aiSettings: {
        provider,
        model,
        apiKey,
        baseUrl,
        defaultContextLimit,
        ...update,
      },
    });
  });

  const handleModelChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ model: e.currentTarget.value });
  });

  const handleApiKeyChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ apiKey: e.currentTarget.value });
  });

  const handleBaseUrlChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ baseUrl: e.currentTarget.value });
  });

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-item">
        <h4 className="settings-item-header">Model</h4>
        <InputText
          value={model}
          label="Model ID"
          onChange={handleModelChange}
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">API</h4>
        <InputText
          value={apiKey}
          label="API Key"
          onChange={handleApiKeyChange}
        />
        <InputText
          value={baseUrl}
          label="Base URL (optional)"
          onChange={handleBaseUrlChange}
        />
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const {
      provider,
      model,
      apiKey,
      baseUrl,
      defaultContextLimit,
    } = global.settings.byKey.aiSettings;

    return {
      provider,
      model,
      apiKey,
      baseUrl,
      defaultContextLimit,
    };
  },
)(SettingsAi));
