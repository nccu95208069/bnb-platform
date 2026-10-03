export function useRouter() {
  return {
    push(url) {
      window.history.pushState({}, "", url);
      window.dispatchEvent(new window.Event("popstate"));
    },
    replace(url) {
      window.history.replaceState({}, "", url);
      window.dispatchEvent(new window.Event("popstate"));
    },
    refresh() {},
  };
}
