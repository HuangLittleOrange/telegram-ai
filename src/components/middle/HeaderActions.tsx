import type { FC } from '../../lib/teact/teact';
import {
  memo, useMemo, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { IAnchorPosition, MessageListType, ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';
import { ManagementScreens } from '../../types';

import { requestMeasure, requestNextMutation } from '../../lib/fasterdom/fasterdom';
import {
  getHasAdminRight,
  getIsSavedDialog,
  isAnonymousForwardsChat,
  isChatBasicGroup, isChatChannel, isChatSuperGroup,
} from '../../global/helpers';
import {
  selectBot,
  selectCanAnimateInterface,
  selectChat,
  selectChatFullInfo,
  selectIsChatBotNotStarted,
  selectIsChatRestricted,
  selectIsChatWithSelf,
  selectIsCurrentUserFrozen,
  selectIsInSelectMode,
  selectIsRightColumnShown,
  selectIsUserBlocked,
} from '../../global/selectors';
import { ARE_CALLS_SUPPORTED, IS_APP } from '../../util/browser/windowEnvironment';
import { isUserId } from '../../util/entities/ids';
import focusNoScroll from '../../util/focusNoScroll';

import { useHotkeys } from '../../hooks/useHotkeys';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import Button from '../ui/Button';
import HeaderMenuContainer from './HeaderMenuContainer.async';

interface OwnProps {
  chatId: string;
  threadId: ThreadId;
  messageListType: MessageListType;
  canExpandActions: boolean;
  isForForum?: boolean;
  isMobile?: boolean;
  onTopicSearch?: NoneToVoidFunction;
}

interface StateProps {
  noMenu?: boolean;
  isChannel?: boolean;
  isRightColumnShown?: boolean;
  canStartBot?: boolean;
  canRestartBot?: boolean;
  canUnblock?: boolean;
  canSubscribe?: boolean;
  canSearch?: boolean;
  canCall?: boolean;
  canMute?: boolean;
  canViewStatistics?: boolean;
  canViewMonetization?: boolean;
  canViewBoosts?: boolean;
  canShowBoostModal?: boolean;
  canLeave?: boolean;
  canEnterVoiceChat?: boolean;
  canCreateVoiceChat?: boolean;
  channelMonoforumId?: string;
  pendingJoinRequests?: number;
  shouldJoinToSend?: boolean;
  shouldSendJoinRequest?: boolean;
  noAnimation?: boolean;
  isAccountFrozen?: boolean;
}

const HeaderActions: FC<OwnProps & StateProps> = ({
  chatId,
  threadId,
  noMenu,
  isMobile,
  isChannel,
  canStartBot,
  canRestartBot,
  canUnblock,
  canSubscribe,
  canSearch,
  canCall,
  canMute,
  canViewStatistics,
  canViewMonetization,
  canViewBoosts,
  canShowBoostModal,
  canLeave,
  canEnterVoiceChat,
  canCreateVoiceChat,
  channelMonoforumId,
  pendingJoinRequests,
  isRightColumnShown,
  isForForum,
  canExpandActions,
  shouldJoinToSend,
  shouldSendJoinRequest,
  noAnimation,
  isAccountFrozen,
  onTopicSearch,
}) => {
  const {
    joinChannel,
    sendBotCommand,
    openMiddleSearch,
    restartBot,
    requestMasterAndRequestCall,
    requestNextManagementScreen,
    showNotification,
    openChat,
    toggleAiAssistant,
    unblockUser,
    setViewForumAsMessages,
    openFrozenAccountModal,
  } = getActions();
  const menuButtonRef = useRef<HTMLButtonElement>();
  const oldLang = useOldLang();

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<IAnchorPosition | undefined>(undefined);

  const handleHeaderMenuOpen = useLastCallback(() => {
    setIsMenuOpen(true);
    const rect = menuButtonRef.current!.getBoundingClientRect();
    setMenuAnchor({ x: rect.right, y: rect.bottom });
  });

  const handleHeaderMenuClose = useLastCallback(() => {
    setIsMenuOpen(false);
  });

  const handleHeaderMenuHide = useLastCallback(() => {
    setMenuAnchor(undefined);
  });

  const handleSubscribeClick = useLastCallback(() => {
    joinChannel({ chatId });
    if (shouldSendJoinRequest) {
      showNotification({
        message: isChannel ? oldLang('RequestToJoinChannelSentDescription')
          : oldLang('RequestToJoinGroupSentDescription'),
      });
    }
  });

  const handleStartBot = useLastCallback(() => {
    sendBotCommand({ command: '/start' });
  });

  const handleRestartBot = useLastCallback(() => {
    restartBot({ chatId });
  });

  const handleUnblock = useLastCallback(() => {
    unblockUser({ userId: chatId });
  });

  const handleJoinRequestsClick = useLastCallback(() => {
    requestNextManagementScreen({ screen: ManagementScreens.JoinRequests });
  });

  const handleSearchClick = useLastCallback(() => {
    if (isForForum) {
      onTopicSearch?.();
      return;
    }

    openMiddleSearch();

    if (noAnimation) {
      // The second RAF is necessary because Teact must update the state and render the async component
      requestMeasure(() => {
        requestNextMutation(setFocusInSearchInput);
      });
    } else {
      setFocusInSearchInput();
    }
  });

  const handleOpenAiAssistant = useLastCallback(() => {
    toggleAiAssistant({ force: true });
  });

  const handleAsMessagesClick = useLastCallback(() => {
    openChat({ id: chatId });
    setViewForumAsMessages({ chatId, isEnabled: true });
  });

  const handleRequestCall = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
      return;
    }
    requestMasterAndRequestCall({ userId: chatId });
  });

  const handleHotkeySearchClick = useLastCallback((e: KeyboardEvent) => {
    if (!canSearch || !IS_APP || e.shiftKey) {
      return;
    }

    e.preventDefault();
    handleSearchClick();
  });

  useHotkeys(useMemo(() => ({
    'Mod+F': handleHotkeySearchClick,
  }), []));

  return (
    <div className="HeaderActions">
      {!isMobile && (
        <>
          {canExpandActions && !shouldSendJoinRequest && (canSubscribe || shouldJoinToSend) && (
            <Button
              size="smaller"
              ripple
              fluid
              onClick={handleSubscribeClick}
            >
              {oldLang(isChannel ? 'ProfileJoinChannel' : 'ProfileJoinGroup')}
            </Button>
          )}
          {canExpandActions && shouldSendJoinRequest && (
            <Button
              size="smaller"
              ripple
              fluid
              onClick={handleSubscribeClick}
            >
              {oldLang('ChannelJoinRequest')}
            </Button>
          )}
          {canExpandActions && canStartBot && (
            <Button
              size="smaller"
              ripple
              fluid
              onClick={handleStartBot}
            >
              {oldLang('BotStart')}
            </Button>
          )}
          {canExpandActions && canRestartBot && (
            <Button
              size="tiny"
              ripple
              fluid
              onClick={handleRestartBot}
            >
              {oldLang('BotRestart')}
            </Button>
          )}
          {canExpandActions && canUnblock && (
            <Button
              size="smaller"
              ripple
              fluid
              onClick={handleUnblock}
            >
              {oldLang('Unblock')}
            </Button>
          )}
          {canSearch && (
            <Button
              round
              ripple={isRightColumnShown}
              color="translucent"
              size="smaller"
              onClick={handleOpenAiAssistant}
              ariaLabel="AI Assistant"
              iconName="bots"
            />
          )}
          {canSearch && (
            <Button
              round
              ripple={isRightColumnShown}
              color="translucent"
              size="smaller"
              onClick={handleSearchClick}
              ariaLabel={oldLang('Conversation.SearchPlaceholder')}
              iconName="search"
            />
          )}
          {canCall && (
            <Button
              round
              color="translucent"
              size="smaller"
              onClick={handleRequestCall}
              ariaLabel="Call"
              iconName="phone"
            />
          )}
        </>
      )}
      {!isForForum && Boolean(pendingJoinRequests) && (
        <Button
          round
          className="badge-button"
          ripple={isRightColumnShown}
          color="translucent"
          size="smaller"
          iconName="user"
          onClick={handleJoinRequestsClick}
          ariaLabel={isChannel ? oldLang('SubscribeRequests') : oldLang('MemberRequests')}
        >
          <div className="badge">{pendingJoinRequests}</div>
        </Button>
      )}
      <Button
        ref={menuButtonRef}
        className={isMenuOpen ? 'active' : ''}
        round
        ripple={!isMobile}
        size="smaller"
        color="translucent"
        disabled={noMenu}
        ariaLabel="More actions"
        onClick={handleHeaderMenuOpen}
        iconName="more"
      />
      {menuAnchor && (
        <HeaderMenuContainer
          chatId={chatId}
          threadId={threadId}
          isOpen={isMenuOpen}
          anchor={menuAnchor}
          withExtraActions={isMobile || !canExpandActions}
          isChannel={isChannel}
          canStartBot={canStartBot}
          canSubscribe={canSubscribe}
          canSearch={canSearch}
          canCall={canCall}
          canMute={canMute}
          canViewStatistics={canViewStatistics}
          canViewBoosts={canViewBoosts}
          canViewMonetization={canViewMonetization}
          canShowBoostModal={canShowBoostModal}
          canLeave={canLeave}
          canEnterVoiceChat={canEnterVoiceChat}
          canCreateVoiceChat={canCreateVoiceChat}
          pendingJoinRequests={pendingJoinRequests}
          onJoinRequestsClick={handleJoinRequestsClick}
          withForumActions={isForForum}
          channelMonoforumId={channelMonoforumId}
          onSubscribeChannel={handleSubscribeClick}
          onSearchClick={handleSearchClick}
          onAsMessagesClick={handleAsMessagesClick}
          onClose={handleHeaderMenuClose}
          onCloseAnimationEnd={handleHeaderMenuHide}
        />
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, {
    chatId, threadId, messageListType, isMobile,
  }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);
    const isChannel = Boolean(chat && isChatChannel(chat));
    const isSuperGroup = Boolean(chat && isChatSuperGroup(chat));
    const isPrivate = isUserId(chatId);

    const isRestricted = selectIsChatRestricted(global, chatId);
    if (!chat || isRestricted || selectIsInSelectMode(global)) {
      return {
        noMenu: true,
      } as Complete<StateProps>;
    }

    const bot = selectBot(global, chatId);
    const chatFullInfo = !isPrivate ? selectChatFullInfo(global, chatId) : undefined;
    const isChatWithSelf = selectIsChatWithSelf(global, chatId);
    const isMainThread = messageListType === 'thread' && threadId === MAIN_THREAD_ID;
    const isDiscussionThread = messageListType === 'thread' && threadId !== MAIN_THREAD_ID;
    const isRightColumnShown = selectIsRightColumnShown(global, isMobile);

    const isSavedDialog = getIsSavedDialog(chatId, threadId, global.currentUserId);

    const isUserBlocked = isPrivate ? selectIsUserBlocked(global, chatId) : false;
    const canRestartBot = Boolean(bot && isUserBlocked);
    const canStartBot = !canRestartBot && Boolean(selectIsChatBotNotStarted(global, chatId));
    const canUnblock = isUserBlocked && !bot;
    const canSubscribe = Boolean(
      (isMainThread || chat.isForum) && (isChannel || isSuperGroup) && chat.isNotJoined && !chat.isMonoforum,
    );
    const canSearch = isMainThread || isDiscussionThread;
    const canCall = ARE_CALLS_SUPPORTED && isUserId(chat.id) && !isChatWithSelf && !bot && !chat.isSupport
      && !isAnonymousForwardsChat(chat.id);
    const canMute = isMainThread && !isChatWithSelf && !canSubscribe;
    const canLeave = isSavedDialog || (isMainThread && !canSubscribe);
    const canEnterVoiceChat = ARE_CALLS_SUPPORTED && isMainThread && chat.isCallActive;
    const canCreateVoiceChat = ARE_CALLS_SUPPORTED && isMainThread && !chat.isCallActive
      && (chat.adminRights?.manageCall || (chat.isCreator && isChatBasicGroup(chat))) && !chat.isMonoforum;
    const canViewStatistics = isMainThread && chatFullInfo?.canViewStatistics;
    const canViewMonetization = isMainThread && chatFullInfo?.canViewMonetization;
    const canViewBoosts = isMainThread && !chat.isMonoforum
      && (isSuperGroup || isChannel) && (canViewStatistics || getHasAdminRight(chat, 'postStories'));
    const canShowBoostModal = !canViewBoosts && (isSuperGroup || isChannel) && !chat.isMonoforum;
    const pendingJoinRequests = isMainThread ? chatFullInfo?.requestsPending : undefined;
    const shouldJoinToSend = Boolean(chat?.isNotJoined && chat.isJoinToSend);
    const shouldSendJoinRequest = Boolean(chat?.isNotJoined && chat.isJoinRequest);
    const noAnimation = !selectCanAnimateInterface(global);

    const isAccountFrozen = selectIsCurrentUserFrozen(global);

    const channelMonoforumId = isChatChannel(chat) ? chat.linkedMonoforumId : undefined;

    return {
      noMenu: false,
      isChannel,
      isRightColumnShown,
      canStartBot,
      canRestartBot,
      canSubscribe,
      canSearch,
      canCall,
      canMute,
      canViewStatistics,
      canViewMonetization,
      canViewBoosts,
      canShowBoostModal,
      canLeave,
      canEnterVoiceChat,
      canCreateVoiceChat,
      pendingJoinRequests,
      shouldJoinToSend,
      shouldSendJoinRequest,
      noAnimation,
      canUnblock,
      isAccountFrozen,
      channelMonoforumId,
    };
  },
)(HeaderActions));

function setFocusInSearchInput() {
  const searchInput = document.querySelector<HTMLInputElement>('#MiddleSearch input');
  if (searchInput) {
    focusNoScroll(searchInput);
  }
}
