// frontend/tailwind.config.js — the Build-BD design system.
// Tokens are the consensus of all 146 Stitch screens (scripts measured every
// screen's config). Three conflicts were resolved deliberately:
//   primary-container      #002045  (92 of 146 screens; alt #1a365d)
//   on-primary-container   #86a0cd  (minority, chosen for 6.4:1 contrast on
//                                    #002045 vs 4.8:1 — accessibility floor)
//   on-surface             #1a1b1e  (90 of 146; #191c1e is indistinguishable)
// CTA amber always carries dark text (9.4:1); white on amber fails WCAG.
'use strict';

module.exports = {
  content: ['./frontend/pages/**/*.html', './frontend/partials/**/*.html', './frontend/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        primary: '#00091b',
        'on-primary': '#ffffff',
        'primary-container': '#002045',
        'on-primary-container': '#86a0cd',
        'primary-fixed': '#d6e3ff',
        'primary-fixed-dim': '#aec7f5',
        'on-primary-fixed': '#001b3c',
        'on-primary-fixed-variant': '#2e476e',
        'inverse-primary': '#aec7f5',
        secondary: '#855300',
        'on-secondary': '#ffffff',
        'secondary-container': '#fdb965',
        'on-secondary-container': '#754900',
        'secondary-fixed': '#ffddb8',
        'secondary-fixed-dim': '#fdb965',
        'on-secondary-fixed': '#2a1700',
        'on-secondary-fixed-variant': '#653e00',
        tertiary: '#160400',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#3c1400',
        'on-tertiary-container': '#b97858',
        'tertiary-fixed': '#ffdbcb',
        'tertiary-fixed-dim': '#ffb692',
        'on-tertiary-fixed': '#341100',
        'on-tertiary-fixed-variant': '#6c391e',
        error: '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',
        success: '#10b981',
        'cta-amber': '#f59e0b',
        background: '#faf9fc',
        'on-background': '#1a1b1e',
        surface: '#faf9fc',
        'surface-main': '#f7f9fb',
        'surface-card': '#ffffff',
        'surface-bright': '#faf9fc',
        'surface-dim': '#dbd9dd',
        'surface-tint': '#465f87',
        'surface-variant': '#e3e2e6',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f4f3f7',
        'surface-container': '#efedf1',
        'surface-container-high': '#e9e7eb',
        'surface-container-highest': '#e3e2e6',
        'on-surface': '#1a1b1e',
        'on-surface-variant': '#44474e',
        'inverse-surface': '#2f3033',
        'inverse-on-surface': '#f1f0f4',
        outline: '#74777f',
        'outline-variant': '#c4c6cf',
        'border-subtle': '#e2e8f0',
        'money-fill': '#047857',
        'danger-fill': '#be123c',
        'warning-fg': '#fbbf24',
        'danger-fg': '#fb7185',
        'text-secondary': '#94a3b8'
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans Bengali', 'system-ui', 'sans-serif'],
        bengali: ['Noto Sans Bengali', 'Inter', 'system-ui', 'sans-serif']
      },
      fontSize: {
        h1: ['36px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '700' }],
        h2: ['30px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        h3: ['24px', { lineHeight: '1.3', letterSpacing: '0', fontWeight: '600' }],
        'display-sm': ['24px', { lineHeight: '1.2', fontWeight: '700' }],
        'title-md': ['18px', { lineHeight: '1.3', fontWeight: '600' }],
        'body-lg': ['18px', { lineHeight: '1.6', letterSpacing: '0', fontWeight: '400' }],
        'body-md': ['16px', { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' }],
        'body-sm': ['14px', { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' }],
        'label-lg': ['20px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'label-md': ['16px', { lineHeight: '1.4', fontWeight: '500' }],
        'label-sm': ['14px', { lineHeight: '1.4', fontWeight: '500' }],
        'label-caps': ['14px', { lineHeight: '1.2', letterSpacing: '0.04em', fontWeight: '700' }],
        'bengali-support': ['16px', { lineHeight: '1.8', fontWeight: '400' }]
      },
      spacing: {
        base: '4px', xs: '4px', sm: '8px', md: '16px', lg: '24px', gutter: '24px', xl: '32px', xxl: '48px'
      },
      maxWidth: { 'container-max': '1280px' },
      borderRadius: { DEFAULT: '0.125rem', lg: '0.25rem', xl: '0.5rem', full: '0.75rem' }
    }
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
