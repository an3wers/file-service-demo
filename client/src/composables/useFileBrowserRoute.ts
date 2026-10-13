import { onScopeDispose, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import type { LocationQueryValue } from "vue-router"
import { useFileBrowser } from "./useFileBrowser"

function queryString(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  return typeof value === "string" ? value : ""
}

export function useFileBrowserRoute(): void {
  const route = useRoute()
  const router = useRouter()
  const browser = useFileBrowser()
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  function cancelSearch(): void {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }

  const unbind = browser.bindNavigation((view) => {
    cancelSearch()
    const query = { ...route.query }
    delete query.directory
    delete query.search
    delete query.page
    if (view.directory) query.directory = view.directory
    if (view.search) query.search = view.search
    if (view.page !== 1) query.page = String(view.page)
    const target = { path: route.path, query, hash: route.hash }
    if (router.resolve(target).fullPath === route.fullPath) browser.restoreView(view)
    else void router.push(target)
  })

  watch(browser.searchInput, (input) => {
    cancelSearch()
    if (input.trim() === browser.search.value) return
    searchTimer = setTimeout(() => browser.applySearch(input.trim()), 350)
  }, { flush: "sync" })

  watch(() => route.query, (query) => {
    cancelSearch()
    if (query.directory === "" || query.search === "" || query.page === "1") {
      const normalized = { ...query }
      if (normalized.directory === "") delete normalized.directory
      if (normalized.search === "") delete normalized.search
      if (normalized.page === "1") delete normalized.page
      void router.replace({ path: route.path, query: normalized, hash: route.hash })
      return
    }
    const page = Number(queryString(query.page))
    browser.restoreView({
      directory: queryString(query.directory),
      search: queryString(query.search),
      page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    })
    cancelSearch()
  }, { immediate: true })

  onScopeDispose(() => {
    cancelSearch()
    unbind()
  })
}
