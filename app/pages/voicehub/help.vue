<template>
  <div class="help-page">
    <div class="help-header">
      <div class="help-tabs">
        <button
          :class="['help-tab', { active: active === 'student' }]"
          type="button"
          @click="setTab('student')"
        >
          同学须知
        </button>
        <button
          :class="['help-tab', { active: active === 'staff' }]"
          type="button"
          @click="setTab('staff')"
        >
          成员须知
        </button>
        <button
          :class="['help-tab', { active: active === 'onepager' }]"
          type="button"
          @click="setTab('onepager')"
        >
          一页纸
        </button>
      </div>
    </div>

    <!-- 三份文档全部常驻 DOM：SSR 即可被搜索引擎抓取，切换仅做显隐，无闪烁 -->
    <div class="help-doc">
      <div v-show="active === 'student'" v-html="docs.student"></div>
      <div v-show="active === 'staff'" v-html="docs.staff"></div>
      <div v-show="active === 'onepager'" v-html="docs.onepager"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
// 以 ?raw 导入文档原文；Vite 返回字符串，v-html 渲染时 {{ }} 占位符按字面显示，不被 Vue 解析
import studentDoc from '~/assets/help/song-request-student-guide.html?raw'
import staffDoc from '~/assets/help/song-request-staff-guide.html?raw'
import onepagerDoc from '~/assets/help/song-request-onepager.html?raw'

const docs = {
  student: studentDoc,
  staff: staffDoc,
  onepager: onepagerDoc
}
const TABS = ['student', 'staff', 'onepager']
const active = ref('onepager')

function tabFromHash() {
  if (typeof window === 'undefined') return
  const hash = window.location.hash.replace('#', '')
  if (TABS.includes(hash)) active.value = hash
}

function setTab(key) {
  active.value = key
  if (typeof window !== 'undefined') {
    // 同步 hash，保证插件深链（/voicehub/help#student）与浏览器前进/后退一致
    window.history.replaceState(null, '', `${window.location.pathname}#${key}`)
  }
}

function onHashChange() {
  tabFromHash()
}

onMounted(() => {
  tabFromHash()
  if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange)
  if (typeof document !== 'undefined') document.title = '点歌帮助 | 校园广播站'
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashChange)
})
</script>

<style scoped>
/* 文档自带浅色样式（随 v-html 注入），这里给浅色底与容器，保证可读、不被站点深色主题吞掉 */
.help-page {
  background: #fafbfc;
  color: #1f2430;
  min-height: 100vh;
}

.help-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #fff;
  border-bottom: 1px solid #e3e7ee;
}

.help-tabs {
  max-width: 980px;
  margin: 0 auto;
  display: flex;
  gap: 8px;
  padding: 12px 16px;
}

.help-tab {
  border: 1px solid #e3e7ee;
  background: #f3f6fc;
  color: #3b6ef5;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.help-tab.active {
  background: #3b6ef5;
  color: #fff;
  border-color: #3b6ef5;
}

.help-doc {
  max-width: 980px;
  margin: 0 auto;
  padding: 16px;
}
</style>
