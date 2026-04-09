// giphy-picker.js — Giphy SDK integration
// This gets bundled by esbuild into public/giphy-bundle.js
// Uses the official @giphy/js-fetch-api and @giphy/js-components

import { GiphyFetch } from '@giphy/js-fetch-api';
import { renderGrid } from '@giphy/js-components';

const GIPHY_KEY = 'HPjDlrmDnoiwmPzwyZipGQ9YScqcnZX5';
const gf = new GiphyFetch(GIPHY_KEY);

let currentRemove = null;
let currentMode = 'trending'; // 'trending', 'search', 'stickers'
let searchTerm = '';
let pickerOpen = false;

// Called when user clicks a GIF — sends it to chat
let onGifSelect = null;

function getFetchGifs(mode, term) {
  return (offset) => {
    if (mode === 'search' && term) {
      return gf.search(term, { offset, limit: 15 });
    } else if (mode === 'stickers' && term) {
      return gf.search(term, { offset, limit: 15, type: 'stickers' });
    } else if (mode === 'stickers') {
      return gf.trending({ offset, limit: 15, type: 'stickers' });
    } else {
      return gf.trending({ offset, limit: 15 });
    }
  };
}

function renderGifGrid(container, mode, term) {
  // Remove existing grid if any
  if (currentRemove) {
    currentRemove();
    currentRemove = null;
  }
  // Clear the container
  container.innerHTML = '';

  const fetchGifs = getFetchGifs(mode, term);

  currentRemove = renderGrid(
    {
      width: container.offsetWidth || 320,
      columns: 3,
      gutter: 4,
      fetchGifs,
      onGifClick: (gif, e) => {
        e.preventDefault();
        // Get the best URL for sending
        const url = gif.images.fixed_height.url || gif.images.original.url;
        if (onGifSelect) {
          onGifSelect(url, gif.title || 'giphy.gif');
        }
      },
    },
    container
  );
}

// Public API — called from the main HTML
window.GiphyPicker = {
  init(containerId, callback) {
    onGifSelect = callback;
  },

  open(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    pickerOpen = true;
    currentMode = 'trending';
    searchTerm = '';
    renderGifGrid(container, currentMode, searchTerm);
  },

  close() {
    pickerOpen = false;
    if (currentRemove) {
      currentRemove();
      currentRemove = null;
    }
  },

  search(containerId, term) {
    const container = document.getElementById(containerId);
    if (!container) return;
    searchTerm = term;
    currentMode = term ? 'search' : 'trending';
    renderGifGrid(container, currentMode, searchTerm);
  },

  stickers(containerId, term) {
    const container = document.getElementById(containerId);
    if (!container) return;
    searchTerm = term || '';
    currentMode = 'stickers';
    renderGifGrid(container, currentMode, searchTerm);
  },

  setMode(containerId, mode, term) {
    const container = document.getElementById(containerId);
    if (!container) return;
    currentMode = mode;
    searchTerm = term || '';
    renderGifGrid(container, currentMode, searchTerm);
  },

  isOpen() {
    return pickerOpen;
  }
};
