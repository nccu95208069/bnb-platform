// Open sold month calendar in a distant month, then evaluate this in a browser.
(async () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 400));
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const date = () => new URLSearchParams(location.search).get('date');
  const previous = date();
  const clickToday = () => [...document.querySelectorAll('button')]
    .find(node => node.textContent.trim() === '今天' && node.getClientRects().length).click();
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  clickToday(); await pause();
  assert(date() === iso, 'Today must retain the actual day, not an intermediate month');
  const day = document.querySelector(`[data-month="${iso.slice(0,7)}-01"] [data-calendar-date="${iso}"]`);
  assert(day && day.getBoundingClientRect().top >= 0 && day.getBoundingClientRect().bottom < innerHeight, 'Today must be visible');
  clickToday(); await pause();
  assert(date() === iso, 'Repeated Today must stay on today');
  history.back(); await pause();
  assert(date() === previous, 'Back must return to the starting month in one step');
  history.forward(); await pause();
  assert(date() === iso, 'Forward must restore today');
  return 'Today, repeated click, visible date, Back and Forward passed';
})()
