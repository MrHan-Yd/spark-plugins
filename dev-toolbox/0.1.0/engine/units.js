/* units.js — 单位换算引擎：长度/面积/体积/质量/温度/压力/功率/能量/密度/力/时间/速度/数据存储/角度 */
var Units = (function () {
  'use strict';

  var CATEGORIES = {
    length: {
      name: '长度', base: '米',
      units: { '毫米': 0.001, '厘米': 0.01, '米': 1, '千米': 1000, '英寸': 0.0254, '英尺': 0.3048, '码': 0.9144, '英里': 1609.344, '海里': 1852, '里': 500, '丈': 3.3333333, '尺': 0.3333333, '寸': 0.0333333, '微米': 1e-6, '纳米': 1e-9 }
    },
    area: {
      'base': '平方米', name: '面积',
      units: { '平方毫米': 1e-6, '平方厘米': 1e-4, '平方米': 1, '平方千米': 1e6, '公顷': 10000, '亩': 666.6667, '平方英寸': 0.00064516, '平方英尺': 0.09290304, '平方码': 0.83612736, '英亩': 4046.8564224 }
    },
    volume: {
      name: '体积', base: '升',
      units: { '毫升': 0.001, '升': 1, '立方米': 1000, '立方英寸': 0.016387064, '立方英尺': 28.316846592, '加仑(美)': 3.785411784, '加仑(英)': 4.54609, '夸脱(美)': 0.946352946, '品脱(美)': 0.473176473, '杯(美)': 0.2365882365, '汤匙(美)': 0.0147867648 }
    },
    mass: {
      name: '质量', base: '千克',
      units: { '毫克': 1e-6, '克': 0.001, '千克': 1, '吨': 1000, '盎司': 0.028349523125, '磅': 0.45359237, '克拉': 0.0002, '两': 0.05, '斤': 0.5, '担': 50 }
    },
    temperature: {
      name: '温度', base: '摄氏度', special: true,
      units: { '摄氏度(°C)': 1, '华氏度(°F)': 1, '开尔文(K)': 1, '兰氏度(°R)': 1 }
    },
    pressure: {
      name: '压力', base: '帕斯卡',
      units: { '帕(Pa)': 1, '千帕(kPa)': 1000, '兆帕(MPa)': 1e6, '巴(bar)': 1e5, '毫巴(mbar)': 100, '标准大气压(atm)': 101325, '毫米汞柱(mmHg)': 133.322368, '毫米水柱': 9.80665, 'psi': 6894.757293, '工程大气压(at)': 98066.5 }
    },
    power: {
      name: '功率', base: '瓦',
      units: { '瓦(W)': 1, '千瓦(kW)': 1000, '兆瓦(MW)': 1e6, '毫瓦(mW)': 0.001, '马力(英制hp)': 745.699872, '马力(公制PS)': 735.49875 }
    },
    energy: {
      name: '功/能量', base: '焦耳',
      units: { '焦耳(J)': 1, '千焦(kJ)': 1000, '兆焦(MJ)': 1e6, '卡(cal)': 4.184, '千卡(kcal)': 4184, '瓦时(Wh)': 3600, '千瓦时(kWh)': 3.6e6, '英热单位(BTU)': 1055.05585262, '电子伏特(eV)': 1.602176634e-19 }
    },
    density: {
      name: '密度', base: '千克/立方米',
      units: { '千克/立方米(kg/m³)': 1, '克/立方厘米(g/cm³)': 1000, '克/毫升(g/mL)': 1000, '磅/立方英尺(lb/ft³)': 16.01846337, '磅/加仑(美)(lb/gal)': 119.826427 }
    },
    force: {
      name: '力', base: '牛顿',
      units: { '牛(N)': 1, '千牛(kN)': 1000, '千克力(kgf)': 9.80665, '达因(dyn)': 1e-5, '磅力(lbf)': 4.4482216152605 }
    },
    time: {
      name: '时间', base: '秒',
      units: { '毫秒(ms)': 0.001, '秒(s)': 1, '分钟(min)': 60, '小时(h)': 3600, '天(d)': 86400, '周': 604800, '月(30天)': 2592000, '年(365天)': 31536000 }
    },
    speed: {
      name: '速度', base: '米/秒',
      units: { '米/秒(m/s)': 1, '千米/时(km/h)': 1 / 3.6, '英里/时(mph)': 0.44704, '英尺/秒(ft/s)': 0.3048, '节(kn)': 0.514444444, '马赫(标准大气)': 340.29 }
    },
    data: {
      name: '数据存储', base: '字节',
      units: { '位(bit)': 0.125, '字节(B)': 1, 'KB': 1e3, 'MB': 1e6, 'GB': 1e9, 'TB': 1e12, 'PB': 1e15, 'KiB': 1024, 'MiB': 1048576, 'GiB': 1073741824, 'TiB': 1099511627776 }
    },
    angle: {
      name: '角度', base: '度',
      units: { '度(°)': 1, '弧度(rad)': 57.29577951308232, '梯度(grad)': 0.9, '周(turn)': 360, '角分(′)': 1 / 60, '角秒(″)': 1 / 3600 }
    }
  };

  function tempConvert(v, from, to) {
    var c;
    switch (from) {
      case '摄氏度(°C)': c = v; break;
      case '华氏度(°F)': c = (v - 32) * 5 / 9; break;
      case '开尔文(K)': c = v - 273.15; break;
      case '兰氏度(°R)': c = (v - 491.67) * 5 / 9; break;
      default: throw new Error('未知温度单位：' + from);
    }
    switch (to) {
      case '摄氏度(°C)': return c;
      case '华氏度(°F)': return c * 9 / 5 + 32;
      case '开尔文(K)': return c + 273.15;
      case '兰氏度(°R)': return (c + 273.15) * 9 / 5;
      default: throw new Error('未知温度单位：' + to);
    }
  }

  function convert(cat, value, from, to) {
    var C = CATEGORIES[cat];
    if (!C) throw new Error('未知类别：' + cat);
    if (!C.units[from] && C.units[from] !== 0) throw new Error('未知单位：' + from);
    if (!C.units[to]) throw new Error('未知单位：' + to);
    var num = Number(value);
    if (!isFinite(num)) throw new Error('请输入有效数字');
    if (C.special) return tempConvert(num, from, to);
    var base = num * C.units[from];
    return base / C.units[to];
  }
  function fmtNum(x) {
    if (x === 0) return '0';
    if (Math.abs(x) >= 1e15 || Math.abs(x) < 1e-9) return x.toExponential(6);
    var s = parseFloat(x.toPrecision(12)).toString();
    return s;
  }

  return { CATEGORIES: CATEGORIES, convert: convert, fmtNum: fmtNum };
})();
if (typeof globalThis !== 'undefined') globalThis.Units = Units;