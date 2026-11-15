import React from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import './style.css';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Options root element missing');
}
createRoot(container).render(
    <React.StrictMode>
        <Options />
    </React.StrictMode>,
);
