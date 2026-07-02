// case22-banner.js — the close handler is attached to the WRONG element: the
// old hidden .close-icon span instead of the visible .close-btn button, so
// clicking the button does nothing.
'use strict';

function closeBanner() {
  document.querySelector('.promo-banner').style.display = 'none';
}

document.querySelector('.close-icon').addEventListener('click', closeBanner);
