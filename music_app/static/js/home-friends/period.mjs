import {mountChoice} from './native-controls.mjs';
const options = [['week','Last week'],['month','Last month'],['six','Last 6 months'],['year','Last year'],['all','All time']];
export function mountPeriod(host, runtime, initial) {
  const settings = props => ({icon:'calendar',className:'home-friends__period',showLabel:false,label:'Period',menuWidth:'content',value:props.value,onChange:props.onChange,title:props.range,options});
  const owner = mountChoice(host,runtime,settings(initial));
  return {element:host,update:props=>owner.update(settings(props)),dispose:()=>owner.dispose()};
}
