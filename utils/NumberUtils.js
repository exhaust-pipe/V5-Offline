export const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export const formatRoundedNumber = (value) => {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
