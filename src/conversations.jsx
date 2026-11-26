import React from 'react';
import './conversations.css';
import { ProjectConversations } from './project-conversations.jsx';
export function Conversations({ state, initialHarness, initialSelection, onClient, onNotify }) {
  return <ProjectConversations state={state} initialHarness={initialHarness} initialSelection={initialSelection} onClient={onClient} onNotify={onNotify} />;
}
