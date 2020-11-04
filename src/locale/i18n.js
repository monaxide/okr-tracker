import Vue from 'vue';
import VueI18n from 'vue-i18n';
import nb from './locales/nb-NO.json';

Vue.use(VueI18n);

export default new VueI18n({
  locale: process.env.VUE_APP_I18N_LOCALE || 'nb-NO',
  fallbackLocale: process.env.VUE_APP_I18N_FALLBACK_LOCALE || 'nb-NO',
  messages: {
    'nb-NO': nb,
  },
});