import isEmpty from '../lib/isEmpty'

export const removeByObj = (obj, id) => {
    if (!isEmpty(obj[id])) delete obj[id];
    return obj
}