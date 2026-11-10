// The API routes a ConferenceDO serves: the four handler modules' arrays, concatenated (PLAN
// section 1.6). Each entry is { method, path, bucket, fail, handler }, where path is a string for
// an exact match or a RegExp whose groups become params.

import talks from './talks/routes.js';
import people from './people/routes.js';
import connect from './connect/routes.js';
import push from './push/routes.js';

export default [...talks, ...people, ...connect, ...push];
