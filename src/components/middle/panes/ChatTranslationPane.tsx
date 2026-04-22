import type { FC } from '../../../lib/teact/teact';
import { memo, useCallback, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { MessageListType, ThreadId } from '../../../types';
import { MAIN_THREAD_ID } from '../../../api/types';

import { COCOON_EMOJI_ID } from '../../../config';
import { isMessageTranslatable } from '../../../global/helpers';
import {
  selectCanTranslateChat,
  selectChat,
  selectChatFullInfo,
  selectChatMessages,
  selectCurrentMessageIds,
  selectIsChatRestricted,
  selectIsInSelectMode,
  selectLanguageCode,
  selectMessageTranslations,
  selectRequestedChatTranslationLanguage,
  selectTranslationLanguage,
  selectUserFullInfo,
} from '../../../global/selectors';
import { isUserId } from '../../../util/entities/ids';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';
import useHeaderPane, { type PaneState } from '../hooks/useHeaderPane';

import CustomEmoji from '../../common/CustomEmoji';
import Button from '../../ui/Button';
import DropdownMenu from '../../ui/DropdownMenu';
import Link from '../../ui/Link';
import MenuItem from '../../ui/MenuItem';
import MenuSeparator from '../../ui/MenuSeparator';

import styles from './ChatTranslationPane.module.scss';

const MESSAGE_LIMIT_PER_TRANSLATION_REQUEST = 20;

type OwnProps = {
  chatId: string;
  threadId: ThreadId;
  messageListType: MessageListType;
  onPaneStateChange?: (state: PaneState) => void;
};

type StateProps = {
  canTranslate?: boolean;
  detectedChatLanguage?: string;
  doNotTranslate: string[];
  isTranslating?: boolean;
  language: string;
  translatableMessageIds?: number[];
  translationLanguage: string;
};

const ChatTranslationPane: FC<OwnProps & StateProps> = ({
  chatId,
  threadId,
  canTranslate,
  detectedChatLanguage,
  doNotTranslate,
  isTranslating,
  language,
  translatableMessageIds,
  translationLanguage,
  onPaneStateChange,
}) => {
  const {
    openChatLanguageModal,
    openCocoonModal,
    requestChatTranslation,
    setSettingOption,
    showNotification,
    togglePeerTranslations,
    translateMessages,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();
  const isOpen = Boolean(canTranslate && threadId === MAIN_THREAD_ID);

  const { ref, shouldRender } = useHeaderPane({
    isOpen,
    onStateChange: onPaneStateChange,
  });

  const getTextWithLanguage = useCallback((langKey: string, langCode: string) => {
    const simplified = langCode.split('-')[0];
    const translationKey = `TranslateLanguage${simplified.toUpperCase()}`;
    const name = oldLang(translationKey);
    if (name !== translationKey) {
      return oldLang(langKey, name);
    }

    const translatedNames = new Intl.DisplayNames([language], { type: 'language' });
    const translatedName = translatedNames.of(langCode)!;
    return oldLang(`${langKey}Other`, translatedName);
  }, [language, oldLang]);

  const buttonText = useMemo(() => {
    if (isTranslating) return oldLang('ShowOriginalButton');

    return getTextWithLanguage('TranslateToButton', translationLanguage);
  }, [translationLanguage, getTextWithLanguage, isTranslating, oldLang]);

  const doNotTranslateText = useMemo(() => {
    if (!detectedChatLanguage) return undefined;

    return getTextWithLanguage('DoNotTranslateLanguage', detectedChatLanguage);
  }, [getTextWithLanguage, detectedChatLanguage]);

  const handleTranslateClick = useLastCallback(() => {
    if (isTranslating) {
      requestChatTranslation({ chatId, toLanguageCode: undefined });
      return;
    }

    requestChatTranslation({ chatId, toLanguageCode: translationLanguage });
    if (translatableMessageIds?.length) {
      translateMessages({ chatId, messageIds: translatableMessageIds, toLanguageCode: translationLanguage });
    }
  });

  const handleChangeLanguage = useLastCallback(() => {
    openChatLanguageModal({ chatId });
  });

  const handleHide = useLastCallback(() => {
    togglePeerTranslations({ chatId, isEnabled: false });
    requestChatTranslation({ chatId, toLanguageCode: undefined });
  });

  const handleDoNotTranslate = useLastCallback(() => {
    if (!detectedChatLanguage) return;

    setSettingOption({
      doNotTranslate: [...doNotTranslate, detectedChatLanguage],
    });
    requestChatTranslation({ chatId, toLanguageCode: undefined });

    showNotification({ message: getTextWithLanguage('AddedToDoNotTranslate', detectedChatLanguage) });
  });

  const handleCocoonClick = useLastCallback(() => {
    openCocoonModal();
  });

  const MoreMenuButton: FC<{ onTrigger: () => void; isOpen?: boolean }> = useMemo(() => {
    return ({ onTrigger, isOpen: isMenuOpen }) => (
      <Button
        round
        ripple
        color="translucent"
        size="smaller"
        className={isMenuOpen ? styles.activeMenuButton : undefined}
        onClick={onTrigger}
        ariaLabel={oldLang('MenuMore')}
        iconName="more"
      />
    );
  }, [oldLang]);

  if (!shouldRender) return undefined;

  return (
    <div ref={ref} className={styles.root}>
      <div className={styles.actions}>
        <Button
          isText
          noForcedUpperCase
          fluid
          size="tiny"
          color="translucent"
          className={styles.translateButton}
          iconName="language"
          iconClassName={styles.languageIcon}
          onClick={handleTranslateClick}
        >
          <span className={styles.buttonText}>{buttonText}</span>
        </Button>
        <Button
          round
          ripple
          color="translucent"
          size="tiny"
          className={styles.changeLanguageButton}
          onClick={handleChangeLanguage}
          ariaLabel={oldLang('Chat.Translate.Menu.To')}
          iconName="down"
        />
      </div>
      <DropdownMenu
        className="stickers-more-menu with-menu-transitions"
        trigger={MoreMenuButton}
        positionX="right"
      >
        <MenuItem icon="language" onClick={handleTranslateClick}>
          {buttonText}
        </MenuItem>
        <MenuItem icon="replace" onClick={handleChangeLanguage}>
          {oldLang('Chat.Translate.Menu.To')}
        </MenuItem>
        <MenuSeparator />
        {detectedChatLanguage
          && <MenuItem icon="hand-stop" onClick={handleDoNotTranslate}>{doNotTranslateText}</MenuItem>}
        <MenuItem icon="close-circle" onClick={handleHide}>{oldLang('Hide')}</MenuItem>
        <MenuSeparator />
        <MenuItem withWrap onClick={handleCocoonClick}>
          {lang('TranslateMenuCocoon', {
            link: (
              <Link isPrimary onClick={(e) => e.preventDefault()}>
                {lang('TranslateMenuCocoonLinkText')}
              </Link>
            ),
          }, {
            withNodes: true,
            withMarkdown: true,
            specialReplacement: {
              '🥚': <CustomEmoji documentId={COCOON_EMOJI_ID} />,
            },
          })}
        </MenuItem>
      </DropdownMenu>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId, threadId, messageListType }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);
    const language = selectLanguageCode(global);
    const translationLanguage = selectTranslationLanguage(global);
    const { doNotTranslate } = global.settings.byKey;

    if (!chat || selectIsChatRestricted(global, chatId) || selectIsInSelectMode(global)) {
      return {
        canTranslate: false,
        detectedChatLanguage: undefined,
        language,
        isTranslating: false,
        translatableMessageIds: undefined,
        translationLanguage,
        doNotTranslate,
      };
    }

    const isPrivate = isUserId(chatId);
    const fullInfo = isPrivate ? selectUserFullInfo(global, chatId) : selectChatFullInfo(global, chatId);
    const currentMessageIds = selectCurrentMessageIds(global, chatId, threadId, messageListType);
    const messagesById = selectChatMessages(global, chatId);
    const messageTranslations = selectMessageTranslations(global, chatId, translationLanguage);
    const translatableMessageIds = currentMessageIds
      ?.filter((id) => {
        const message = messagesById?.[id];
        const translation = messageTranslations[id];
        return message && isMessageTranslatable(message) && !translation?.text && !translation?.isPending;
      })
      .slice(0, MESSAGE_LIMIT_PER_TRANSLATION_REQUEST);

    return {
      canTranslate: selectCanTranslateChat(global, chatId) && !fullInfo?.isTranslationDisabled,
      detectedChatLanguage: chat.detectedLanguage,
      doNotTranslate,
      isTranslating: Boolean(selectRequestedChatTranslationLanguage(global, chatId)),
      language,
      translatableMessageIds,
      translationLanguage,
    };
  },
)(ChatTranslationPane));
