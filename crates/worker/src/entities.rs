use std::borrow::Cow;

use html_escape::NAMED_ENTITIES;

// These HTML named character references can also be written without a semicolon.
const LEGACY: &[&str] = &[
    "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml", "COPY", "Ccedil",
    "ETH", "Eacute", "Ecirc", "Egrave", "Euml", "GT", "Iacute", "Icirc", "Igrave", "Iuml", "LT",
    "Ntilde", "Oacute", "Ocirc", "Ograve", "Oslash", "Otilde", "Ouml", "QUOT", "REG", "THORN",
    "Uacute", "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute", "aelig", "agrave",
    "amp", "aring", "atilde", "auml", "brvbar", "ccedil", "cedil", "cent", "copy", "curren", "deg",
    "divide", "eacute", "ecirc", "egrave", "eth", "euml", "frac12", "frac14", "frac34", "gt",
    "iacute", "icirc", "iexcl", "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro",
    "middot", "nbsp", "not", "ntilde", "oacute", "ocirc", "ograve", "ordf", "ordm", "oslash",
    "otilde", "ouml", "para", "plusmn", "pound", "quot", "raquo", "reg", "sect", "shy", "sup1",
    "sup2", "sup3", "szlig", "thorn", "times", "uacute", "ucirc", "ugrave", "uml", "uuml",
    "yacute", "yen", "yuml",
];

pub fn decode(source: &str, attribute: bool) -> Cow<'_, str> {
    let Some(first) = source.find('&') else {
        return Cow::Borrowed(source);
    };
    let mut text = String::with_capacity(source.len());
    text.push_str(&source[..first]);
    let mut remaining = &source[first..];
    while let Some(index) = remaining.find('&') {
        text.push_str(&remaining[..index]);
        let after = &remaining[index + 1..];
        if let Some(number) = after.strip_prefix('#') {
            if let Some((consumed, value)) = numeric(number) {
                text.push(value);
                remaining = &number[consumed..];
                continue;
            }
        } else if let Some((length, value)) = named(after, attribute) {
            text.push_str(value);
            remaining = &after[length..];
            continue;
        }
        text.push('&');
        remaining = after;
    }
    text.push_str(remaining);
    Cow::Owned(text)
}

fn named(input: &str, attribute: bool) -> Option<(usize, &'static str)> {
    let end = input.bytes().take_while(u8::is_ascii_alphanumeric).count();
    if input.as_bytes().get(end) == Some(&b';')
        && let Some(text) = lookup(&input[..end])
    {
        return Some((end + 1, text));
    }
    for length in (1..=end.min(6)).rev() {
        let name = &input[..length];
        if LEGACY.binary_search(&name).is_ok()
            && (!attribute
                || !input
                    .as_bytes()
                    .get(length)
                    .is_some_and(|&byte| byte.is_ascii_alphanumeric() || byte == b'='))
        {
            return lookup(name).map(|text| (length, text));
        }
    }
    None
}

fn lookup(name: &str) -> Option<&'static str> {
    NAMED_ENTITIES
        .binary_search_by_key(&name.as_bytes(), |entry| entry.0)
        .ok()
        .map(|index| NAMED_ENTITIES[index].1)
}

fn numeric(number: &str) -> Option<(usize, char)> {
    let hexadecimal = number.starts_with(['x', 'X']);
    let base = if hexadecimal { 16 } else { 10 };
    let skip = usize::from(hexadecimal);
    let digits = number[skip..]
        .bytes()
        .take_while(|byte| {
            if hexadecimal {
                byte.is_ascii_hexdigit()
            } else {
                byte.is_ascii_digit()
            }
        })
        .count();
    if digits == 0 {
        return None;
    }
    let end = skip + digits;
    let consumed = end + usize::from(number.as_bytes().get(end) == Some(&b';'));
    let scalar = u32::from_str_radix(&number[skip..end], base).unwrap_or(0);
    // The HTML parser maps these numeric references through Windows-1252.
    const C1: &[u32] = &[
        0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
        0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
        0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
    ];
    let value = if (0x80..=0x9f).contains(&scalar) {
        C1[(scalar - 0x80) as usize]
    } else {
        scalar
    };
    Some((
        consumed,
        char::from_u32(value)
            .filter(|&ch| ch != '\0')
            .unwrap_or('\u{fffd}'),
    ))
}
