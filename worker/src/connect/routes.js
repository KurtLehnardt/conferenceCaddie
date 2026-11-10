// The connect routes of the ConferenceDO (PLAN section 2, rows 20 to 26 and 30): presence and the
// Bluetooth token rotation (presence.js), and asks, waves and meets (meets.js).

import presence from './presence.js';
import meets from './meets.js';

export default [...presence, ...meets];
