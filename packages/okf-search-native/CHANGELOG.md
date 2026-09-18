# Changelog

## [0.7.1](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.7.0...okf-search-native-v0.7.1) (2026-09-18)


### Bug Fixes

* **okf-search-native:** narrow prepared API option types ([#100](https://github.com/robhowley/okf-search/issues/100)) ([63254ce](https://github.com/robhowley/okf-search/commit/63254ce9e28070cb7eb886c6a7d83651243be857))
* **okf-search-native:** separate type checking from tests ([#102](https://github.com/robhowley/okf-search/issues/102)) ([f966155](https://github.com/robhowley/okf-search/commit/f96615533d8322e580d6d88175a8d12b2e42b722))

## [0.7.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.6.0...okf-search-native-v0.7.0) (2026-09-17)


### Features

* **okf-search-native:** allow configurable snippet length ([#95](https://github.com/robhowley/okf-search/issues/95)) ([897e01a](https://github.com/robhowley/okf-search/commit/897e01a98b57772d1e2bdc7d35d771fd9b9de257))


### Bug Fixes

* **okf-search-native:** anchor fuzzy snippets on analyzed tokens ([#98](https://github.com/robhowley/okf-search/issues/98)) ([c349408](https://github.com/robhowley/okf-search/commit/c349408c4357d456bfcbced823bb5f2b1a8475d9))
* **okf-search-native:** count snippet length in UTF-16 units ([#97](https://github.com/robhowley/okf-search/issues/97)) ([31d5da3](https://github.com/robhowley/okf-search/commit/31d5da38d9502a85101c670729ca1a9646ad3a32))

## [0.6.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.5.1...okf-search-native-v0.6.0) (2026-09-15)


### Features

* **okf-search-native:** add explicit cache persistence ([#91](https://github.com/robhowley/okf-search/issues/91)) ([830b9bf](https://github.com/robhowley/okf-search/commit/830b9bfb3882cb965b57119d03d2ebcd1f38885a))


### Performance Improvements

* **okf-search-native:** remove unused stored fields ([#92](https://github.com/robhowley/okf-search/issues/92)) ([2abb24e](https://github.com/robhowley/okf-search/commit/2abb24eb7b26115a2967597ca91606d7b59cfd08))

## [0.5.1](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.5.0...okf-search-native-v0.5.1) (2026-09-14)


### Bug Fixes

* **okf-search-native:** skip section preparation during validation ([#87](https://github.com/robhowley/okf-search/issues/87)) ([95a4df9](https://github.com/robhowley/okf-search/commit/95a4df977a2accd31f17378f4bb03c304f3ad6a2))

## [0.5.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.4.0...okf-search-native-v0.5.0) (2026-09-14)


### Features

* **okf-search-native:** move document preparation to Rust ([#81](https://github.com/robhowley/okf-search/issues/81)) ([1724f32](https://github.com/robhowley/okf-search/commit/1724f32477a8ff51492972055b9f9e051060dc5c))


### Bug Fixes

* **okf-search-native:** enable CPU-aware indexing and improve package README ([#86](https://github.com/robhowley/okf-search/issues/86)) ([6b6bd9f](https://github.com/robhowley/okf-search/commit/6b6bd9fee1af676d30f4afb1e05952d43d0db5d6))

## [0.4.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.3.4...okf-search-native-v0.4.0) (2026-09-09)


### Features

* add unified index stats API ([#76](https://github.com/robhowley/okf-search/issues/76)) ([36e7b9f](https://github.com/robhowley/okf-search/commit/36e7b9f203b3553f3c63829d383a19f2be7abef5))

## [0.3.4](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.3.3...okf-search-native-v0.3.4) (2026-09-05)


### Bug Fixes

* **okf-search-native:** harden prepared search options ([#71](https://github.com/robhowley/okf-search/issues/71)) ([83cbcde](https://github.com/robhowley/okf-search/commit/83cbcde7495ffe516c824a441542c708e618a2a3))

## [0.3.3](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.3.2...okf-search-native-v0.3.3) (2026-09-04)


### Bug Fixes

* **okf-search-native:** make Windows candidate non-blocking ([#67](https://github.com/robhowley/okf-search/issues/67)) ([35221b9](https://github.com/robhowley/okf-search/commit/35221b9909bb62e3c0adc8a6b32a1f7a5cdbe063))

## [0.3.2](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.3.1...okf-search-native-v0.3.2) (2026-09-04)


### Bug Fixes

* **okf-search-native:** validate prepared line numbers ([#65](https://github.com/robhowley/okf-search/issues/65)) ([22fd40d](https://github.com/robhowley/okf-search/commit/22fd40d9b6f921d4475e7aff77f5703171c9d048))

## [0.3.1](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.3.0...okf-search-native-v0.3.1) (2026-09-04)


### Bug Fixes

* **okf-search-native:** reject fractional stale epochs ([#62](https://github.com/robhowley/okf-search/issues/62)) ([0fe89a2](https://github.com/robhowley/okf-search/commit/0fe89a2c6d853ece2da826c9f3a8a2b638141285))

## [0.3.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.2.0...okf-search-native-v0.3.0) (2026-09-04)


### Features

* **okf-search-native:** add friendly Markdown root ([#57](https://github.com/robhowley/okf-search/issues/57)) ([77adb20](https://github.com/robhowley/okf-search/commit/77adb20c4612515282940f0f5648c265fd229a05))

## [0.2.0](https://github.com/robhowley/okf-search/compare/okf-search-native-v0.1.0...okf-search-native-v0.2.0) (2026-09-03)


### Features

* **okf-search-native:** add prepared-document Tantivy backend ([#55](https://github.com/robhowley/okf-search/issues/55)) ([943e12e](https://github.com/robhowley/okf-search/commit/943e12e2dec26e7d01d3049d27e8ef4a6285a114))
